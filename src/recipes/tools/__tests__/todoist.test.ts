/**
 * Todoist recipe-step tool tests.
 *
 * Mocks the Todoist connector module so each tool's `execute` can be driven
 * without network access, then fetches each registered tool from the recipe
 * tool registry by id and asserts:
 *   - the correct connector method is called with faithfully-mirrored,
 *     positionally-mapped args,
 *   - the JSON-stringified connector result is returned verbatim,
 *   - read/write + risk metadata is what the registry advertises.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  todoistV1Project,
  todoistV1Task,
} from "../../../connectors/__tests__/todoistV1Fixture.js";

// ── Connector mock ────────────────────────────────────────────────────────────
// The tool module `await import("../../connectors/todoist.js")` lazily, so the
// mock must be hoisted (vi.mock is hoisted automatically) and expose
// getTodoistConnector returning an object of spies. From this test file
// (src/recipes/tools/__tests__/) the connector lives three levels up.

const getTasks = vi.fn();
const createTask = vi.fn();
const closeTask = vi.fn();
const getProjects = vi.fn();
const reopenTask = vi.fn();
const deleteTask = vi.fn();

vi.mock("../../../connectors/todoist.js", () => ({
  getTodoistConnector: () => ({
    getTasks,
    createTask,
    closeTask,
    getProjects,
    reopenTask,
    deleteTask,
  }),
}));

// Import AFTER the mock is declared so the self-registering module picks it up.
import "../todoist.js";
import { getTool } from "../../toolRegistry.js";
import type { RunContext, StepDeps } from "../../yamlRunner.js";

/** Minimal ToolContext factory — tools only read `params`. */
function ctx(params: Record<string, unknown>) {
  return {
    params,
    step: {} as Record<string, unknown>,
    ctx: {} as RunContext,
    deps: {} as StepDeps,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("todoist recipe-step tools", () => {
  describe("todoist.list_tasks", () => {
    it("is registered read-only / low risk", () => {
      const tool = getTool("todoist.list_tasks");
      expect(tool).toBeDefined();
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls getTasks(projectId, filter, limit) and returns its JSON", async () => {
      // The shared v1 shape, not a hand-written one. The body this file used to
      // declare carried REST v2 names the API does not send — the same invented
      // shape that let the connector's own bug survive nine days of green tests.
      const tasks = [todoistV1Task({ id: "1", content: "Write tests" })];
      getTasks.mockResolvedValue(tasks);

      const tool = getTool("todoist.list_tasks");
      const out = await tool?.execute(
        ctx({ projectId: "p1", filter: "today", limit: 25 }),
      );

      expect(getTasks).toHaveBeenCalledWith("p1", "today", 25);
      expect(out).toBe(JSON.stringify(tasks));
    });

    it("passes undefined for omitted optional params", async () => {
      getTasks.mockResolvedValue([]);
      const tool = getTool("todoist.list_tasks");
      await tool?.execute(ctx({}));

      expect(getTasks).toHaveBeenCalledWith(undefined, undefined, undefined);
    });
  });

  describe("todoist.create_task", () => {
    it("is registered as a write / medium risk tool", () => {
      const tool = getTool("todoist.create_task");
      expect(tool).toBeDefined();
      expect(tool?.isWrite).toBe(true);
      expect(tool?.riskDefault).toBe("medium");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls createTask(content, projectId, description, dueString, priority, labels) and returns its JSON", async () => {
      const created = todoistV1Task({
        id: "9",
        content: "Ship it",
        description: "now",
        priority: 4,
        labels: ["Work"],
      });
      createTask.mockResolvedValue(created);

      const tool = getTool("todoist.create_task");
      const out = await tool?.execute(
        ctx({
          content: "Ship it",
          projectId: "p1",
          description: "now",
          dueString: "tomorrow",
          priority: 4,
          labels: ["Work"],
        }),
      );

      expect(createTask).toHaveBeenCalledWith(
        "Ship it",
        "p1",
        "now",
        "tomorrow",
        4,
        ["Work"],
      );
      expect(out).toBe(JSON.stringify(created));
    });

    it("passes undefined for omitted optional params", async () => {
      createTask.mockResolvedValue({ id: "1", content: "x" });
      const tool = getTool("todoist.create_task");
      await tool?.execute(ctx({ content: "x" }));

      expect(createTask).toHaveBeenCalledWith(
        "x",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      );
    });
  });

  describe("todoist.close_task", () => {
    it("is registered as a write / medium risk tool", () => {
      const tool = getTool("todoist.close_task");
      expect(tool).toBeDefined();
      expect(tool?.isWrite).toBe(true);
      expect(tool?.riskDefault).toBe("medium");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls closeTask(id) and returns a structured ack", async () => {
      closeTask.mockResolvedValue(undefined);

      const tool = getTool("todoist.close_task");
      const out = await tool?.execute(ctx({ id: "42" }));

      expect(closeTask).toHaveBeenCalledWith("42");
      expect(out).toBe(JSON.stringify({ ok: true, id: "42" }));
    });
  });

  describe("todoist.list_projects", () => {
    it("is registered read-only / low risk", () => {
      const tool = getTool("todoist.list_projects");
      expect(tool).toBeDefined();
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls getProjects() with no args and returns its JSON", async () => {
      const projects = [todoistV1Project({ id: "p1", name: "Inbox" })];
      getProjects.mockResolvedValue(projects);

      const tool = getTool("todoist.list_projects");
      const out = await tool?.execute(ctx({}));

      expect(getProjects).toHaveBeenCalledWith();
      expect(out).toBe(JSON.stringify(projects));
    });
  });
});

// ── Compensating actions (#1264) ─────────────────────────────────────────────
// `close_task` and `create_task` shipped without their inverses, even though
// the connector has implemented both since day one. An action with no
// reachable inverse is irreversible for reasons unrelated to the vendor API.
describe("todoist compensating actions", () => {
  it("exposes todoist.reopen_task as the inverse of close_task", async () => {
    const tool = getTool("todoist.reopen_task");
    expect(tool).toBeDefined();
    expect(tool?.isWrite).toBe(true);
    expect(tool?.isConnector).toBe(true);

    reopenTask.mockResolvedValue(undefined);
    const out = await tool?.execute(ctx({ id: "42" }));
    expect(reopenTask).toHaveBeenCalledWith("42");
    expect(JSON.parse(out as string)).toEqual({ ok: true, id: "42" });
  });

  it("exposes todoist.delete_task as the inverse of create_task", async () => {
    const tool = getTool("todoist.delete_task");
    expect(tool).toBeDefined();
    expect(tool?.isWrite).toBe(true);

    deleteTask.mockResolvedValue(undefined);
    const out = await tool?.execute(ctx({ id: "7" }));
    expect(deleteTask).toHaveBeenCalledWith("7");
    expect(JSON.parse(out as string)).toEqual({ ok: true, id: "7" });
  });

  it("returns the created task id so a later delete can target it", async () => {
    createTask.mockResolvedValue({ id: "99", content: "x" });
    const out = await getTool("todoist.create_task")?.execute(
      ctx({ content: "x" }),
    );
    expect(JSON.parse(out as string).id).toBe("99");
  });
});
