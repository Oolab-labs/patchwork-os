/**
 * A subprocess driver must not report a child killed by a signal as success
 * (audit M25, 2026-10-15).
 *
 * Node's `close` event gives `code === null` and a signal name when a child
 * is killed. All three subprocess drivers resolved `code ?? 0`, so an
 * out-of-memory kill or any external SIGKILL, with no result event, came
 * back as exit 0 — a successful run with whatever partial text it had.
 * An abort is NOT affected (Node's spawn `signal` option raises an `error`
 * event that each driver's catch path turns into `wasAborted`); those tests
 * pin that it stays so.
 *
 * Real child processes, not a mocked spawn: the existing driver tests' mock
 * child emits `close` with code 0 when killed, which is exactly the fiction
 * that hid this.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SubprocessDriver } from "../claude/subprocess.js";
import { CodexDriver } from "../codex/subprocess.js";
import { GeminiSubprocessDriver } from "../gemini/index.js";
import type { ProviderDriver, ProviderTaskInput } from "../types.js";

const posix = process.platform !== "win32";
const dir = mkdtempSync(join(tmpdir(), "driver-signal-exit-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function script(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

const selfKill = posix ? script("self-kill.sh", "kill -9 $$") : "";
const sleeper = posix ? script("sleeper.sh", "sleep 30") : "";
const noop = () => {};

const drivers: Array<[string, (bin: string) => ProviderDriver]> = [
  ["claude", (bin) => new SubprocessDriver(bin, bin, noop)],
  ["codex", (bin) => new CodexDriver(bin, noop)],
  ["gemini", (bin) => new GeminiSubprocessDriver(bin, noop)],
];

function input(signal: AbortSignal): ProviderTaskInput {
  return {
    prompt: "hello",
    workspace: dir,
    timeoutMs: 20_000,
    signal,
  };
}

describe.skipIf(!posix)(
  "subprocess drivers: a signal-killed child is a failure",
  () => {
    for (const [name, make] of drivers) {
      it(`${name}: a child killed by SIGKILL reports a non-zero exit`, async () => {
        const result = await make(selfKill).run(
          input(new AbortController().signal),
        );
        // 128 + SIGKILL (9), the shell's convention.
        expect(result.exitCode).toBe(137);
      });

      it(`${name}: an aborted run reports wasAborted, not success`, async () => {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 300);
        const result = await make(sleeper).run(input(ac.signal));
        expect(result.exitCode).not.toBe(0);
        expect(result.wasAborted).toBe(true);
      });
    }
  },
);
