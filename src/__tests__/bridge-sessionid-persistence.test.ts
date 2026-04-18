/**
 * Regression guard for sessionId truncation in activity-log metadata.
 *
 * Background: bridge.ts writes lifecycle events to activityLog so downstream
 * consumers (e.g. dashboard session detail) can correlate by sessionId. A
 * long-standing bug truncated sessionId to 8 chars inside recordEvent
 * metadata, making correlation impossible (truncated "31f13def" never matches
 * the full UUID known to /sessions).
 *
 * This test lints every production source file under src/ to ensure every
 * `activityLog.recordEvent(...)` call with a `sessionId` field passes the
 * *full* identifier, not a truncated slice/substring/substr.
 *
 * Scope widened from just bridge.ts (PR #23's original guard) so that any
 * future file gaining a recordEvent call site is covered automatically.
 * Test files and fixtures are excluded — they may deliberately record
 * truncated values for unit-test coverage of edge cases.
 *
 * Human-readable log strings (logger.info/warn/error) are allowed to keep the
 * short form — readability there outweighs correlation, and logs aren't a
 * structured correlation surface.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIR = join(__dirname, "..");

/** Recursively enumerate .ts files under src/, skipping tests and node_modules. */
function collectSources(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      out.push(...collectSources(full));
    } else if (
      st.isFile() &&
      entry.endsWith(".ts") &&
      !entry.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Extract the argument body (balanced parens) of every
 * `activityLog.recordEvent(...)` call in `src`.
 */
function findRecordEventCalls(src: string): string[] {
  const starter = /activityLog\??\.recordEvent\(/g;
  const bodies: string[] = [];
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical regex loop
  while ((m = starter.exec(src)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      i += 1;
    }
    if (depth === 0) bodies.push(src.slice(start, i - 1));
  }
  return bodies;
}

// Matches any `sessionId: <ident>.slice/substring/substr(0, N)` or template-
// literal truncations inside the metadata object. Accepts `sessionId` or
// `sessionID` (defensive against a rename typo). Uses /s flag so multi-line
// argument objects are covered.
const TRUNCATED_SESSIONID = new RegExp(
  [
    // Plain truncation: sessionId: foo.slice(0, 8) / .substring(...) / .substr(...)
    "sessionI[dD]\\s*:\\s*[A-Za-z_][A-Za-z0-9_]*\\.",
    "(?:slice|substring|substr)\\(",
  ].join(""),
  "s",
);

// Template-literal truncation: sessionId: `${foo.slice(0,8)}...`
const TRUNCATED_SESSIONID_TEMPLATE = new RegExp(
  [
    "sessionI[dD]\\s*:\\s*`[^`]*\\$\\{[^}]*\\.",
    "(?:slice|substring|substr)\\(",
  ].join(""),
  "s",
);

describe("activity log metadata preserves full sessionId", () => {
  it("enumerates at least one production recordEvent call site", () => {
    // Sanity: the lint is meaningless if no call sites are found.
    const files = collectSources(SRC_DIR);
    let totalCalls = 0;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      totalCalls += findRecordEventCalls(src).length;
    }
    expect(totalCalls).toBeGreaterThan(0);
  });

  it("never truncates sessionId in activityLog.recordEvent metadata (all src files)", () => {
    const files = collectSources(SRC_DIR);
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const calls = findRecordEventCalls(src);
      for (const body of calls) {
        if (
          TRUNCATED_SESSIONID.test(body) ||
          TRUNCATED_SESSIONID_TEMPLATE.test(body)
        ) {
          const rel = file.slice(SRC_DIR.length + 1);
          offenders.push(`${rel}: ${body.trim().replace(/\s+/g, " ")}`);
        }
      }
    }
    expect(
      offenders,
      "sessionId inside activityLog.recordEvent metadata must be the full " +
        "UUID — truncation breaks /sessions/:id correlation. Human-readable " +
        "log strings (logger.info/warn) are free to use short forms.\n\n" +
        `Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
