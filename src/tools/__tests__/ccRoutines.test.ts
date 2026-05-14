import { describe, expect, it } from "vitest";
import type { RoutinesExecutor } from "../ccRoutines.js";
import {
  createGetRoutineStatusTool,
  createListRoutinesTool,
  createRunRoutineTool,
} from "../ccRoutines.js";

// ---------------------------------------------------------------------------
// Executor helpers
// ---------------------------------------------------------------------------

function okExec(stdout: string): RoutinesExecutor {
  return async () => ({ stdout });
}

function errExec(msg: string): RoutinesExecutor {
  return async () => {
    throw new Error(msg);
  };
}

function parseResult(result: unknown) {
  const r = result as { content: Array<{ text: string }>; isError?: boolean };
  return { isError: r.isError, data: JSON.parse(r.content[0]!.text) };
}

// ---------------------------------------------------------------------------
// listRoutines
// ---------------------------------------------------------------------------

describe("listRoutines", () => {
  it("returns routines array on success", async () => {
    const routines = [
      {
        id: "r1",
        name: "nightly-review",
        schedule: "0 2 * * *",
        status: "idle",
      },
      {
        id: "r2",
        name: "health-check",
        schedule: "0 * * * *",
        status: "running",
      },
    ];
    const tool = createListRoutinesTool(
      "claude",
      okExec(JSON.stringify(routines)),
    );

    const { isError, data } = parseResult(await tool.handler({}));
    expect(isError).toBeFalsy();
    expect(data.routines).toHaveLength(2);
    expect(data.routines[0].id).toBe("r1");
  });

  it("returns cc_routines_unavailable when command not found", async () => {
    const tool = createListRoutinesTool(
      "claude",
      errExec("unknown command: routines"),
    );

    const { isError, data } = parseResult(await tool.handler({}));
    expect(isError).toBe(true);
    expect(data.error).toBe("cc_routines_unavailable");
  });

  it("wraps object payload with .routines key", async () => {
    const payload = { routines: [{ id: "r3", name: "inbox" }] };
    const tool = createListRoutinesTool(
      "claude",
      okExec(JSON.stringify(payload)),
    );

    const { isError, data } = parseResult(await tool.handler({}));
    expect(isError).toBeFalsy();
    expect(data.routines[0].id).toBe("r3");
  });

  it("falls back to line-split when output is not JSON", async () => {
    const tool = createListRoutinesTool(
      "claude",
      okExec("nightly-review\nhealth-check\n"),
    );

    const { isError, data } = parseResult(await tool.handler({}));
    expect(isError).toBeFalsy();
    expect(data.routines).toHaveLength(2);
  });

  it("returns error on unexpected exec failure", async () => {
    const tool = createListRoutinesTool("claude", errExec("permission denied"));

    const { isError } = parseResult(await tool.handler({}));
    expect(isError).toBe(true);
  });

  it("matches outputSchema shape — routines is array", async () => {
    const tool = createListRoutinesTool(
      "claude",
      okExec(JSON.stringify([{ id: "r1", name: "daily" }])),
    );

    const { data } = parseResult(await tool.handler({}));
    expect(Array.isArray(data.routines)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runRoutine
// ---------------------------------------------------------------------------

describe("runRoutine", () => {
  it("returns taskId and status on success", async () => {
    const tool = createRunRoutineTool(
      "claude",
      okExec(JSON.stringify({ taskId: "task-abc", status: "running" })),
    );

    const { isError, data } = parseResult(await tool.handler({ id: "r1" }));
    expect(isError).toBeFalsy();
    expect(data.taskId).toBe("task-abc");
    expect(data.status).toBe("running");
  });

  it("rejects empty id", async () => {
    const tool = createRunRoutineTool("claude", okExec("{}"));
    const { isError } = parseResult(await tool.handler({ id: "" }));
    expect(isError).toBe(true);
  });

  it("rejects missing id", async () => {
    const tool = createRunRoutineTool("claude", okExec("{}"));
    const { isError } = parseResult(await tool.handler({}));
    expect(isError).toBe(true);
  });

  it("returns cc_routines_unavailable when command not found", async () => {
    const tool = createRunRoutineTool("claude", errExec("not found"));

    const { isError, data } = parseResult(await tool.handler({ id: "r1" }));
    expect(isError).toBe(true);
    expect(data.error).toBe("cc_routines_unavailable");
  });

  it("falls back to id+running on non-JSON output", async () => {
    const tool = createRunRoutineTool("claude", okExec("started"));

    const { isError, data } = parseResult(await tool.handler({ id: "r1" }));
    expect(isError).toBeFalsy();
    expect(data.taskId).toBe("r1");
    expect(data.status).toBe("running");
  });

  it("uses parsed taskId when JSON contains it", async () => {
    const tool = createRunRoutineTool(
      "claude",
      okExec(JSON.stringify({ taskId: "t2", status: "pending" })),
    );

    const { isError, data } = parseResult(
      await tool.handler({ id: "r2", input: '{"key":"val"}' }),
    );
    expect(isError).toBeFalsy();
    expect(data.taskId).toBe("t2");
  });
});

// ---------------------------------------------------------------------------
// getRoutineStatus
// ---------------------------------------------------------------------------

describe("getRoutineStatus", () => {
  it("returns status fields on success", async () => {
    const payload = {
      id: "r1",
      status: "idle",
      lastRun: "2026-05-13T02:00:00Z",
      nextRun: "2026-05-14T02:00:00Z",
      output: "All checks passed",
    };
    const tool = createGetRoutineStatusTool(
      "claude",
      okExec(JSON.stringify(payload)),
    );

    const { isError, data } = parseResult(await tool.handler({ id: "r1" }));
    expect(isError).toBeFalsy();
    expect(data.id).toBe("r1");
    expect(data.status).toBe("idle");
    expect(data.lastRun).toBe("2026-05-13T02:00:00Z");
    expect(data.output).toBe("All checks passed");
  });

  it("rejects whitespace-only id", async () => {
    const tool = createGetRoutineStatusTool("claude", okExec("{}"));
    const { isError } = parseResult(await tool.handler({ id: "  " }));
    expect(isError).toBe(true);
  });

  it("returns cc_routines_unavailable when subcommand unknown", async () => {
    const tool = createGetRoutineStatusTool(
      "claude",
      errExec("Unknown argument: routines"),
    );

    const { isError, data } = parseResult(await tool.handler({ id: "r1" }));
    expect(isError).toBe(true);
    expect(data.error).toBe("cc_routines_unavailable");
  });

  it("falls back to id+unknown on non-JSON output", async () => {
    const tool = createGetRoutineStatusTool("claude", okExec("no json here"));

    const { isError, data } = parseResult(await tool.handler({ id: "r1" }));
    expect(isError).toBeFalsy();
    expect(data.id).toBe("r1");
    expect(data.status).toBe("unknown");
  });

  it("handles snake_case keys from CLI", async () => {
    const tool = createGetRoutineStatusTool(
      "claude",
      okExec(
        JSON.stringify({
          id: "r1",
          status: "running",
          last_run: "2026-05-14T01:00:00Z",
        }),
      ),
    );

    const { data } = parseResult(await tool.handler({ id: "r1" }));
    expect(data.lastRun).toBe("2026-05-14T01:00:00Z");
  });
});
