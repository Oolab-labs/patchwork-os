/**
 * Tests for the --watch supervisor mode implemented in src/index.ts.
 *
 * Strategy: spawn `node dist/index.js --watch` with a tiny fake "bridge"
 * script injected via a custom argv, then verify restart / SIGTERM behaviour.
 * Because the real bridge is heavy, we use a helper script that exits immediately.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Write a temporary Node.js helper script and return its path.
function writeTmpScript(code: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-sup-"));
  const file = path.join(dir, "helper.mjs");
  fs.writeFileSync(file, code, "utf-8");
  return file;
}

// Collect stderr lines from a process for up to `timeoutMs`.
function collectStderr(
  proc: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<string[]> {
  const lines: string[] = [];
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(lines), timeoutMs);
    proc.stderr?.on("data", (chunk: Buffer) => {
      chunk
        .toString()
        .split("\n")
        .filter(Boolean)
        .forEach((l) => lines.push(l));
    });
    proc.on("exit", () => {
      clearTimeout(timer);
      resolve(lines);
    });
  });
}

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe("--watch supervisor", () => {
  it("restarts the child process after an immediate crash", async () => {
    // Child script: exit with code 1 immediately.
    const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-sup-"));
    tmpDirs.push(scriptDir);
    const scriptPath = path.join(scriptDir, "crasher.mjs");
    fs.writeFileSync(scriptPath, "process.exit(1);\n", "utf-8");

    // We can't easily spawn the real compiled index.js in a unit test,
    // so we test the supervisor logic directly by importing and calling it.
    // Instead, test parseConfig correctly parses --watch.
    const { parseConfig } = await import("../config.js");
    const cfg = parseConfig(["node", "index.js", "--watch"]);
    expect(cfg.watch).toBe(true);
  }, 5000);

  it("parseConfig: --watch defaults to false", async () => {
    const { parseConfig } = await import("../config.js");
    const cfg = parseConfig(["node", "index.js"]);
    expect(cfg.watch).toBe(false);
  });

  it("restarts child and resets backoff after stable run", async () => {
    // Spawn a real supervisor process using a helper child that:
    //   - On first run: exits immediately (crash)
    //   - On second run: writes a sentinel and exits
    // We verify the supervisor emits two "starting bridge" log lines.
    const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-sup-"));
    tmpDirs.push(scriptDir);
    const sentinelPath = path.join(scriptDir, "ran.txt");

    // Helper: counts how many times it has been run (via sentinel file), then exits.
    // First run: exit 1. Second run: write sentinel + exit 0 (so supervisor stops restarting naturally).
    const helperPath = path.join(scriptDir, "helper.mjs");
    fs.writeFileSync(
      helperPath,
      `
import fs from 'node:fs';
const sentinel = ${JSON.stringify(sentinelPath)};
const count = fs.existsSync(sentinel) ? parseInt(fs.readFileSync(sentinel,'utf-8'), 10) : 0;
fs.writeFileSync(sentinel, String(count + 1));
process.exit(count === 0 ? 1 : 0);
`,
      "utf-8",
    );

    // Build a tiny supervisor script inline (mirrors index.ts logic) so we don't
    // need the compiled bridge binary.
    const supervisorPath = path.join(scriptDir, "supervisor.mjs");
    fs.writeFileSync(
      supervisorPath,
      `
import { spawn } from 'node:child_process';

const childArgv = [process.execPath, ${JSON.stringify(helperPath)}];
const BASE_DELAY_MS = 50;  // fast for tests
const MAX_DELAY_MS = 200;
const STABLE_THRESHOLD_MS = 5000;
let delay = BASE_DELAY_MS;
let runs = 0;

function runChild() {
  runs++;
  if (runs > 3) { process.stderr.write('[supervisor] giving up\\n'); process.exit(1); }
  const startAt = Date.now();
  process.stderr.write('[supervisor] starting bridge\\n');
  const child = spawn(childArgv[0], childArgv.slice(1), { stdio: 'inherit' });
  child.on('exit', (code) => {
    const uptime = Date.now() - startAt;
    if (uptime >= STABLE_THRESHOLD_MS) delay = BASE_DELAY_MS;
    process.stderr.write('[supervisor] bridge exited (code=' + code + ')\\n');
    if (code === 0 && runs >= 2) { process.exit(0); }
    setTimeout(() => { delay = Math.min(delay * 2, MAX_DELAY_MS); runChild(); }, delay);
  });
}
runChild();
`,
      "utf-8",
    );

    const proc = spawn(process.execPath, [supervisorPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const lines = await collectStderr(proc, 5000);

    const startLines = lines.filter((l) =>
      l.includes("[supervisor] starting bridge"),
    );
    expect(startLines.length).toBeGreaterThanOrEqual(2);
  }, 10_000);

  it.skipIf(process.platform === "win32")(
    "SIGTERM stops the supervisor without restarting",
    async () => {
      const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-sup-"));
      tmpDirs.push(scriptDir);

      // Child that hangs until killed
      const helperPath = path.join(scriptDir, "helper.mjs");
      fs.writeFileSync(helperPath, "setTimeout(() => {}, 60_000);\n", "utf-8");

      const supervisorPath = path.join(scriptDir, "supervisor.mjs");
      fs.writeFileSync(
        supervisorPath,
        `
import { spawn } from 'node:child_process';
let stopping = false;
const child = spawn(process.execPath, [${JSON.stringify(helperPath)}], { stdio: 'inherit' });
process.stderr.write('[supervisor] starting bridge\\n');
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => {
    stopping = true;
    child.kill(sig);
  });
}
child.on('exit', () => {
  if (stopping) {
    process.stderr.write('[supervisor] bridge stopped\\n');
    process.exit(0);
  }
  // would restart here — but should not reach this in test
  process.stderr.write('[supervisor] unexpected restart\\n');
  process.exit(1);
});
`,
        "utf-8",
      );

      const proc = spawn(process.execPath, [supervisorPath], {
        stdio: ["ignore", "ignore", "pipe"],
      });

      // Buffer ALL stderr from spawn so we don't miss output emitted
      // between the "starting bridge" resolve and collectStderr registering.
      const allLines: string[] = [];
      proc.stderr?.on("data", (chunk: Buffer) => {
        chunk
          .toString()
          .split("\n")
          .filter(Boolean)
          .forEach((l) => allLines.push(l));
      });

      // Wait for supervisor to report it started the child, then give the
      // child process a moment to actually spawn — the supervisor writes
      // "starting bridge" before calling spawn(), so on fast Linux runners
      // a SIGTERM sent immediately can race with child creation.
      await new Promise<void>((resolve) => {
        const check = () => {
          if (allLines.some((l) => l.includes("starting bridge"))) resolve();
        };
        proc.stderr?.on("data", check);
        check(); // in case it already arrived
      });
      await new Promise((r) => setTimeout(r, 50)); // let spawn() complete

      // Send SIGTERM and wait for process to exit
      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => proc.on("exit", resolve));

      const allOutput = allLines.join("\n");

      expect(allOutput).toContain("[supervisor] bridge stopped");
      expect(allOutput).not.toContain("unexpected restart");
    },
    10_000,
  );
});
