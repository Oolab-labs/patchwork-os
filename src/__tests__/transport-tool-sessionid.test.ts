/**
 * Regression guard for tool-call sessionId wiring on WebSocket transports.
 *
 * Background: PR #24 added sessionId to ActivityEntry so /sessions/:id could
 * correlate tool calls to sessions. The initial wiring passed
 * `this.claudeCodeSessionId` from the three `activityLog?.record(...)` call
 * sites in transport.ts. That field is only set on the streamable-HTTP path
 * from the X-Claude-Code-Session-Id header — WebSocket transports (what the
 * Claude Code CLI uses) never set it, so every WS tool call was recorded with
 * sessionId=undefined and excluded from querySessionTools. The dashboard
 * /sessions/:id view stayed empty despite the bridge being correctly wired.
 *
 * Fix was to use `this.sessionId` instead — bridge.ts assigns it at WS
 * connect (the same UUID persisted in lifecycle metadata by PR #23), so
 * tool-call correlation works on both transports.
 *
 * This test source-lints transport.ts to ensure no activityLog?.record()
 * call ever reaches for claudeCodeSessionId again.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Extract the balanced argument strings for every `activityLog?.record(...)`
 * or `activityLog.record(...)` call in `src`. Handles nested parens
 * (Date.now(), ?? undefined, etc.).
 */
function findActivityLogRecordCalls(src: string): string[] {
  const starter = /activityLog\??\.record\(/g;
  const calls: string[] = [];
  let m: RegExpExecArray | null;
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
    if (depth === 0) {
      // i now points just past the closing paren; argument body is [start, i-1)
      calls.push(src.slice(start, i - 1));
    }
  }
  return calls;
}

describe("transport tool-call sessionId wiring", () => {
  it("never passes claudeCodeSessionId to activityLog.record", () => {
    const path = join(__dirname, "..", "transport.ts");
    const src = readFileSync(path, "utf8");
    const calls = findActivityLogRecordCalls(src);
    const offenders = calls.filter((args) => /claudeCodeSessionId/.test(args));
    expect(
      offenders,
      "activityLog.record() must pass this.sessionId (not this.claudeCodeSessionId) — " +
        "the latter is null on WebSocket transports, breaking session correlation. " +
        `See PR #24 bug for context.\n\nOffending calls:\n${offenders.join("\n\n")}`,
    ).toEqual([]);
  });

  it("passes this.sessionId at every tool-call record site", () => {
    const path = join(__dirname, "..", "transport.ts");
    const src = readFileSync(path, "utf8");
    const calls = findActivityLogRecordCalls(src);
    expect(
      calls.length,
      "expected at least 3 activityLog.record sites in transport.ts",
    ).toBeGreaterThanOrEqual(3);

    const missingSessionId = calls.filter(
      (args) => !/this\.sessionId/.test(args),
    );
    expect(
      missingSessionId,
      "every activityLog.record() in transport.ts should pass this.sessionId so " +
        "the /sessions/:id drill-down can correlate tool entries. If a new call site is " +
        "intentionally session-less, update this test's expectation.\n\nSites missing " +
        `sessionId:\n${missingSessionId.join("\n\n")}`,
    ).toEqual([]);
  });
});
