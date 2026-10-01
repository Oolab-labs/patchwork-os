/**
 * `patchwork launchd status` — advertised in `--help` since the LaunchAgent
 * command shipped, and until 2026-10-01 the dispatcher had no such branch:
 * `launchd status` printed the install|uninstall usage line and exited 1.
 * Found by the docs pass, which verifies the CLI reference against the binary.
 *
 * Deps are injected (filesystem probe, launchctl runner, platform) so the test
 * never touches a real LaunchAgent and runs on Linux CI.
 */
import { describe, expect, it } from "vitest";
import { type LaunchdStatusDeps, runLaunchdStatus } from "../launchd.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: (over: Partial<LaunchdStatusDeps>): LaunchdStatusDeps => ({
      platform: "darwin",
      uid: 501,
      exists: () => true,
      launchctlPrint: () => ({ status: 0, stdout: "" }),
      stdout: (s) => {
        out.push(s);
      },
      stderr: (s) => {
        err.push(s);
      },
      ...over,
    }),
  };
}

const RUNNING = [
  "co.patchwork-os.bridge = {",
  "\tactive count = 1",
  "\tpath = /Users/someone/Library/LaunchAgents/co.patchwork-os.bridge.plist",
  "\tstate = running",
  "\tpid = 64137",
  "\tlast exit code = 0",
  "}",
].join("\n");

describe("runLaunchdStatus", () => {
  it("not installed → exit 1, says so, never calls launchctl", async () => {
    const c = capture();
    let called = false;
    const code = await runLaunchdStatus(
      [],
      c.deps({
        exists: () => false,
        launchctlPrint: () => {
          called = true;
          return { status: 0, stdout: RUNNING };
        },
      }),
    );
    expect(code).toBe(1);
    expect(c.out.join("")).toMatch(/not installed/i);
    expect(called).toBe(false);
  });

  it("installed but not loaded → exit 1, loaded: no", async () => {
    const c = capture();
    const code = await runLaunchdStatus(
      [],
      c.deps({ launchctlPrint: () => ({ status: 113, stdout: "" }) }),
    );
    expect(code).toBe(1);
    expect(c.out.join("")).toMatch(/Loaded:\s+no/);
  });

  it("installed, loaded and running → exit 0 with the pid", async () => {
    const c = capture();
    const code = await runLaunchdStatus(
      [],
      c.deps({ launchctlPrint: () => ({ status: 0, stdout: RUNNING }) }),
    );
    expect(code).toBe(0);
    const text = c.out.join("");
    expect(text).toMatch(/Loaded:\s+yes/);
    expect(text).toMatch(/running/);
    expect(text).toContain("64137");
  });

  it("loaded but not running → exit 1 and the last exit code", async () => {
    const c = capture();
    const stopped = RUNNING.replace("state = running", "state = not running")
      .replace("\tpid = 64137\n", "")
      .replace("last exit code = 0", "last exit code = 143");
    const code = await runLaunchdStatus(
      [],
      c.deps({ launchctlPrint: () => ({ status: 0, stdout: stopped }) }),
    );
    expect(code).toBe(1);
    expect(c.out.join("")).toMatch(/not running/);
    expect(c.out.join("")).toContain("143");
  });

  it("--json emits one object with the same facts", async () => {
    const c = capture();
    const code = await runLaunchdStatus(
      ["--json"],
      c.deps({ launchctlPrint: () => ({ status: 0, stdout: RUNNING }) }),
    );
    expect(code).toBe(0);
    const obj = JSON.parse(c.out.join("")) as Record<string, unknown>;
    expect(obj).toMatchObject({
      label: "co.patchwork-os.bridge",
      installed: true,
      loaded: true,
      running: true,
      pid: 64137,
      lastExitCode: 0,
    });
    expect(typeof obj.plistPath).toBe("string");
  });

  it("not macOS → exit 1 with the same message install uses", async () => {
    const c = capture();
    const code = await runLaunchdStatus([], c.deps({ platform: "linux" }));
    expect(code).toBe(1);
    expect(c.err.join("")).toMatch(/only available on macOS/);
  });
});
