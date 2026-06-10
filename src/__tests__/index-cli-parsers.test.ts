/**
 * Audit 2026-06-10 cluster C7 regression tests for inline CLI parsers in
 * src/index.ts.
 *
 * src/index.ts is a top-of-script executable — importing it runs the dispatch
 * side effects against live process.argv (see knownSubcommands.test.ts for the
 * same constraint). The env-loader and the notify arg-parser are inline in the
 * module body and not exported, so — mirroring the existing knownSubcommands
 * test — these tests replicate the exact fixed logic and assert it on the
 * inputs that triggered each bug. The subprocess-level behavior of
 * cli-commands-1 (`status --port` validation) is covered separately by
 * index-cli-status-port.test.ts.
 *
 * cli-commands-5 — notify arg parser must NOT drop a trailing bare `--flag`.
 * cli-commands-6 — .env parser must NOT capture an inline comment as the value.
 */

import { describe, expect, it } from "vitest";

// ── cli-commands-5: notify arg parser (mirror of src/index.ts) ─────────────────
//
// Faithful copy of the FIXED loop. Pre-fix the loop condition was
// `i < notifyRest.length - 1`, which silently dropped a trailing bare `--flag`.
function parseNotifyArgs(notifyRest: string[]): Record<string, string> {
  const namedArgs: Record<string, string> = {};
  for (let i = 0; i < notifyRest.length; i++) {
    const arg = notifyRest[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const next = notifyRest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        namedArgs[key] = next;
        i++;
      } else {
        namedArgs[key] = "";
      }
    }
  }
  return namedArgs;
}

describe("cli-commands-5 — notify arg parser keeps a trailing bare flag", () => {
  it("records a trailing --flag with no value as empty string (was dropped)", () => {
    const args = parseNotifyArgs(["--taskId", "abc", "--prompt"]);
    expect(args.taskId).toBe("abc");
    // The bug: `prompt` key was missing entirely; now it's an empty string.
    expect(Object.hasOwn(args, "prompt")).toBe(true);
    expect(args.prompt).toBe("");
  });

  it("still parses normal --key value pairs", () => {
    const args = parseNotifyArgs(["--taskId", "t1", "--prompt", "do it"]);
    expect(args).toEqual({ taskId: "t1", prompt: "do it" });
  });

  it("treats --flag followed by another --flag as an empty-valued flag", () => {
    const args = parseNotifyArgs(["--verbose", "--taskId", "x"]);
    expect(args.verbose).toBe("");
    expect(args.taskId).toBe("x");
  });
});

// ── cli-commands-6: .env parser (mirror of src/index.ts) ───────────────────────
//
// Faithful copy of the FIXED parser. Pre-fix the regex `=(.*)$` captured inline
// comments into the value (e.g. PORT=3000 # default → "3000 # default").
function parseEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(trimmed);
  if (!m?.[1]) return null;
  let raw = m[2] ?? "";
  const isQuoted =
    (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
    (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2);
  if (!isQuoted) {
    const hashIdx = raw.indexOf("#");
    if (hashIdx !== -1) raw = raw.slice(0, hashIdx);
    raw = raw.trim();
  }
  return { key: m[1], value: raw.replace(/^["']|["']$/g, "") };
}

describe("cli-commands-6 — .env parser strips inline comments", () => {
  it("does NOT capture an inline comment as part of the value", () => {
    const parsed = parseEnvLine("PORT=3000 # default port");
    expect(parsed).toEqual({ key: "PORT", value: "3000" });
  });

  it("preserves a '#' inside a double-quoted value", () => {
    const parsed = parseEnvLine('SECRET="a#b#c"');
    expect(parsed).toEqual({ key: "SECRET", value: "a#b#c" });
  });

  it("preserves a '#' inside a single-quoted value", () => {
    const parsed = parseEnvLine("TOKEN='x#y'");
    expect(parsed).toEqual({ key: "TOKEN", value: "x#y" });
  });

  it("parses a plain value with no comment unchanged", () => {
    const parsed = parseEnvLine("NAME=patchwork");
    expect(parsed).toEqual({ key: "NAME", value: "patchwork" });
  });

  it("skips a full-line comment", () => {
    expect(parseEnvLine("# this is a comment")).toBeNull();
  });

  it("skips a blank line", () => {
    expect(parseEnvLine("   ")).toBeNull();
  });

  it("trims surrounding whitespace before the comment", () => {
    const parsed = parseEnvLine("KEY=value   # trailing");
    expect(parsed).toEqual({ key: "KEY", value: "value" });
  });
});
