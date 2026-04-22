import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DecisionTraceLog } from "../../decisionTraceLog.js";
import { createCtxQueryTracesTool } from "../ctxQueryTraces.js";
import { createCtxSaveTraceTool } from "../ctxSaveTrace.js";

let dir: string;
let log: DecisionTraceLog;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "ctx-save-trace-"));
  log = new DecisionTraceLog({ dir });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

const WS = "/tmp/ws";

describe("ctxSaveTrace", () => {
  it("records a trace and returns seq + ref", async () => {
    const tool = createCtxSaveTraceTool(WS, log);
    const res = parse(
      await tool.handler({
        ref: "#42",
        problem: "auth times out",
        solution: "lazy-init token cache",
      }),
    );
    expect(res.seq).toBe(1);
    expect(res.ref).toBe("#42");
    expect(typeof res.createdAt).toBe("number");
    expect(log.size()).toBe(1);
  });

  it("persists tags when provided", async () => {
    const tool = createCtxSaveTraceTool(WS, log);
    const res = parse(
      await tool.handler({
        ref: "#1",
        problem: "p",
        solution: "s",
        tags: ["perf", "db"],
      }),
    );
    expect(res.tags).toEqual(["perf", "db"]);
  });

  it("attaches sessionId from the getter callback", async () => {
    const tool = createCtxSaveTraceTool(WS, log, () => "session-abc");
    await tool.handler({ ref: "#1", problem: "p", solution: "s" });
    const stored = log.query()[0];
    expect(stored?.sessionId).toBe("session-abc");
  });

  it("returns an error payload on invalid input", async () => {
    const tool = createCtxSaveTraceTool(WS, log);
    const res = await tool.handler({
      ref: "#1",
      problem: "p",
      solution: "x".repeat(600),
    });
    expect(res.content[0]?.text).toContain("exceeds");
  });

  it("trims whitespace from ref / problem / solution via log", async () => {
    const tool = createCtxSaveTraceTool(WS, log);
    const res = parse(
      await tool.handler({
        ref: "  #42  ",
        problem: "  trimmed  ",
        solution: "  also trimmed  ",
      }),
    );
    expect(res.ref).toBe("#42");
    expect(log.query()[0]?.problem).toBe("trimmed");
  });

  it("writes workspace through to the log", async () => {
    const tool = createCtxSaveTraceTool("/my/workspace", log);
    await tool.handler({ ref: "#1", problem: "p", solution: "s" });
    expect(log.query()[0]?.workspace).toBe("/my/workspace");
  });
});

describe("ctxSaveTrace → ctxQueryTraces roundtrip (agent-read loop)", () => {
  it("trace written by ctxSaveTrace is immediately readable via ctxQueryTraces", async () => {
    const saveTool = createCtxSaveTraceTool(WS, log);
    const queryTool = createCtxQueryTracesTool({
      activityLog: null,
      commitIssueLinkLog: null,
      recipeRunLog: null,
      decisionTraceLog: log,
    });

    // Step 1 — write
    const saveRes = JSON.parse(
      (
        await saveTool.handler({
          ref: "ctx-loop-test-2026-04-22",
          problem:
            "Validating that ctxSaveTrace persists traces readable by future sessions",
          solution:
            "ctxSaveTrace writes to decision_traces.jsonl; ctxQueryTraces reads it back",
          tags: ["loop-test", "dogfood"],
        })
      ).content[0]?.text ?? "{}",
    );
    expect(saveRes.seq).toBe(1);
    expect(saveRes.ref).toBe("ctx-loop-test-2026-04-22");

    // Step 2 — read back
    const queryRes = JSON.parse(
      (await queryTool.handler({ traceType: "decision", limit: 5 })).content[0]
        ?.text ?? "{}",
    );
    expect(queryRes.count).toBe(1);
    const trace = queryRes.traces[0];
    expect(trace.key).toBe("ctx-loop-test-2026-04-22");
    expect(trace.body.tags).toEqual(["loop-test", "dogfood"]);
  });
});
