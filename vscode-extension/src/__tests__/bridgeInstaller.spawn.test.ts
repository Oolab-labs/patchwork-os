import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeInstaller } from "../bridgeInstaller";

// child_process is NOT mocked in this file, on purpose.
//
// bridgeInstaller.test.ts hands the installer errors that were shaped by hand.
// Whether a missing binary really arrives as `code: "ENOENT"`, a timeout as
// `killed`, a file that cannot be executed as `EACCES`, is decided by Node and
// the operating system. The installer installs on exactly one of those
// answers, so these tests run real processes and read the answers from them.

const isWindows = process.platform === "win32";

const output = {
  appendLine: () => {},
} as unknown as import("vscode").OutputChannel;

let dir: string;
let savedPath: string | undefined;
let savedPrefix: string | undefined;

beforeEach(() => {
  // realpath: the temp directory is a symlink on macOS and can be an 8.3
  // short path on Windows.
  dir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "bridge-probe-")),
  );
  savedPath = process.env.PATH;
  savedPrefix = process.env.npm_config_prefix;
});

afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  if (savedPrefix === undefined) delete process.env.npm_config_prefix;
  else process.env.npm_config_prefix = savedPrefix;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Put `dir` first on PATH, ahead of whatever bridge this machine has. */
function putDirFirstOnPath(): void {
  process.env.PATH = `${dir}${path.delimiter}${savedPath ?? ""}`;
}

/** Leave nothing on PATH but `dir`. */
function putOnlyDirOnPath(): void {
  process.env.PATH = dir;
}

describe.skipIf(isWindows)("probeInstalled against real processes", () => {
  function fakeBridge(script: string, mode = 0o755): void {
    fs.writeFileSync(
      path.join(dir, "claude-ide-bridge"),
      `#!/bin/sh\n${script}\n`,
      { mode },
    );
  }

  it("reports missing when there is no such binary on PATH", async () => {
    putOnlyDirOnPath();

    expect(await new BridgeInstaller(output).probeInstalled()).toEqual({
      kind: "missing",
    });
  });

  it("reads the version a real binary prints", async () => {
    fakeBridge('echo "claude-ide-bridge 9.8.7"');
    putDirFirstOnPath();

    expect(await new BridgeInstaller(output).probeInstalled()).toEqual({
      kind: "installed",
      version: "9.8.7",
    });
  });

  it("reports unknown when the binary fails, even if it complains of ENOENT", async () => {
    fakeBridge(
      "echo \"Error: ENOENT: no such file or directory, open 'config.json'\" >&2\nexit 1",
    );
    putDirFirstOnPath();

    expect(await new BridgeInstaller(output).probeInstalled()).toEqual({
      kind: "unknown",
      reason: "it exited with code 1",
    });
  });

  it("reports unknown when the binary does not answer in time", async () => {
    // `exec`, so the timeout's signal reaches the sleeping process itself.
    fakeBridge("exec sleep 5");
    putDirFirstOnPath();
    const started = Date.now();

    const found = await new BridgeInstaller(output, {
      versionCheckTimeoutMs: 300,
    }).probeInstalled();

    expect(found).toEqual({
      kind: "unknown",
      reason: "it did not finish in time",
    });
    // It was stopped, not waited for.
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("reports unknown when the file is there but cannot be executed", async () => {
    fakeBridge('echo "claude-ide-bridge 9.8.7"', 0o644);
    // Only this directory: the search skips a file it may not execute and
    // would otherwise go on to find the bridge this machine really has.
    putOnlyDirOnPath();

    expect(await new BridgeInstaller(output).probeInstalled()).toEqual({
      kind: "unknown",
      reason: "it could not be started (EACCES)",
    });
  });

  it("reports unknown when the binary prints no version", async () => {
    fakeBridge('echo "usage: claude-ide-bridge [options]"');
    putDirFirstOnPath();

    expect(await new BridgeInstaller(output).probeInstalled()).toEqual({
      kind: "unknown",
      reason: "it printed no version number",
    });
  });
});

describe.skipIf(isWindows)("probeNpmGlobal against the real npm", () => {
  /** Make the npm that the installer runs use `dir` as its global prefix. */
  function useDirAsNpmPrefix(): void {
    process.env.npm_config_prefix = dir;
  }

  it("reports missing for a prefix that has never held a global package", async () => {
    // No `lib` directory at all. Real npm does not print an empty tree here:
    // it fails with an ENOENT error object. Read as "cannot tell", that would
    // mean a machine like this never gets its first install.
    useDirAsNpmPrefix();

    expect(await new BridgeInstaller(output).probeNpmGlobal()).toEqual({
      kind: "missing",
    });
  }, 45_000);

  it("reports missing for a global directory that is there and empty", async () => {
    fs.mkdirSync(path.join(dir, "lib", "node_modules"), { recursive: true });
    useDirAsNpmPrefix();

    expect(await new BridgeInstaller(output).probeNpmGlobal()).toEqual({
      kind: "missing",
    });
  }, 45_000);

  it("reads the version of a copy in npm's global directory", async () => {
    const pkg = path.join(dir, "lib", "node_modules", "patchwork-os");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "patchwork-os", version: "9.8.7" }),
    );
    useDirAsNpmPrefix();

    expect(await new BridgeInstaller(output).probeNpmGlobal()).toEqual({
      kind: "installed",
      version: "9.8.7",
    });
  }, 45_000);

  it("can read what npm really prints, whether or not a bridge is installed", async () => {
    // The machine running this may or may not have the bridge installed
    // globally, so the answer is not fixed. What must hold is that npm's
    // real output is one the installer can read: `unknown` here would mean
    // the installer has stopped being able to install anything.
    const found = await new BridgeInstaller(output).probeNpmGlobal();

    expect(found.kind, JSON.stringify(found)).not.toBe("unknown");
  }, 45_000);
});

// These two pin how things ARE on Windows, not how they should be.
//
// npm's global binaries are `.cmd` shims there, and Node refuses to start a
// `.cmd` file without a shell (EINVAL) before it even looks for it. So the
// version check cannot succeed, and it cannot tell "not installed" apart
// either: both arrive as the same refusal. The installer reads that as
// `unknown` and installs nothing, which is the safe answer — but it also
// means the extension does not install the bridge on Windows.
//
// Whoever makes the check work on Windows should expect both of these to
// fail, and replace them with the expectations of the block above.
describe.runIf(isWindows)("probeInstalled on Windows", () => {
  it("cannot read the version through the .cmd shim, and says unknown", async () => {
    fs.writeFileSync(
      path.join(dir, "claude-ide-bridge.cmd"),
      "@echo claude-ide-bridge 9.8.7\r\n",
    );
    putDirFirstOnPath();

    expect(await new BridgeInstaller(output).probeInstalled()).toEqual({
      kind: "unknown",
      reason: "it could not be started (EINVAL)",
      refused: true,
    });
  });

  it("says unknown, not missing, when there is no bridge at all", async () => {
    putOnlyDirOnPath();

    expect(await new BridgeInstaller(output).probeInstalled()).toEqual({
      kind: "unknown",
      reason: "it could not be started (EINVAL)",
      refused: true,
    });
  });
});
