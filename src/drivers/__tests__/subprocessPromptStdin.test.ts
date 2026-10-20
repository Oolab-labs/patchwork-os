/**
 * Subprocess drivers deliver the prompt on STDIN, never in argv
 * (Private/52 LOW).
 *
 * All three CLI drivers (claude, codex, gemini) put the task text — and with
 * it whatever the recipe fed in: mail, tickets, file contents — into the
 * child's argument list, where any local process can read it with `ps` for
 * the life of the run. Each CLI reads its prompt from standard input instead
 * (`claude -p` with no prompt argument, `codex exec -`, and `gemini -p`,
 * which APPENDS its value to stdin, so it is given an empty one).
 *
 * Real child processes that record their argv and stdin.
 */

import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { SubprocessDriver as LegacyClaudeDriver } from "../../claudeDriver.js";
import { SubprocessDriver } from "../claude/subprocess.js";
import { CodexDriver } from "../codex/subprocess.js";
import { GeminiSubprocessDriver } from "../gemini/index.js";

const posix = process.platform !== "win32";
const dir = mkdtempSync(join(tmpdir(), "driver-prompt-stdin-"));
const argvFile = join(dir, "argv");
const stdinFile = join(dir, "stdin");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  vi.stubEnv("HOME", dir);
  vi.stubEnv("USERPROFILE", dir);
  vi.stubEnv("REC_ARGV", argvFile);
  vi.stubEnv("REC_STDIN", stdinFile);
  writeFileSync(argvFile, "");
  writeFileSync(stdinFile, "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const recorder = (() => {
  if (!posix) return "";
  const p = join(dir, "recorder.sh");
  writeFileSync(
    p,
    '#!/bin/sh\nfor a in "$@"; do printf "%s\\0" "$a" >> "$REC_ARGV"; done\ncat > "$REC_STDIN"\nexit 0\n',
  );
  chmodSync(p, 0o755);
  return p;
})();

const PROMPT = "Summarise the ticket: SECRET-TASK-TEXT-7731";
const noop = () => {};

type Runner = (bin: string) => Promise<unknown>;
const input = () => ({
  prompt: PROMPT,
  workspace: dir,
  timeoutMs: 20_000,
  signal: new AbortController().signal,
});

const drivers: Array<[string, Runner]> = [
  ["claude", (bin) => new SubprocessDriver(bin, bin, noop).run(input())],
  ["codex", (bin) => new CodexDriver(bin, noop).run(input())],
  ["gemini", (bin) => new GeminiSubprocessDriver(bin, noop).run(input())],
  [
    "claude (legacy claudeDriver.ts)",
    (bin) => new LegacyClaudeDriver(bin, bin, noop).run(input()),
  ],
];

describe.skipIf(!posix)("subprocess drivers: prompt on stdin", () => {
  for (const [name, run] of drivers) {
    it(`${name}: the prompt is not in argv`, async () => {
      await run(recorder);
      const argv = readFileSync(argvFile, "utf8").split("\0").join(" ");
      expect(argv).not.toContain("SECRET-TASK-TEXT-7731");
    });

    it(`${name}: the prompt arrives on stdin`, async () => {
      await run(recorder);
      expect(readFileSync(stdinFile, "utf8")).toContain(PROMPT);
    });
  }
});
