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

// ── Connector mock ────────────────────────────────────────────────────────────
// The tool module `await import("../../connectors/todoist.js")` lazily, so the
// mock must be hoisted (vi.mock is hoisted automatically) and expose
// getTodoistConnector returning an object of spies. From this test file
// (src/recipes/tools/__tests__/) the connector lives three levels up.

const getTasks = vi.fn();
const createTask = vi.fn();
const closeTask = vi.fn();
const getProjects = vi.fn();

vi.mock("../../../connectors/todoist.js", () => ({
  getTodoistConnector: () => ({
    getTasks,
    createTask,
    closeTask,
    getProjects,
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
      const tasks = [
        {
          id: "1",
          content: "Write tests",
          description: "",
          project_id: "p1",
          section_id: null,
          parent_id: null,
          order: 1,
          priority: 1,
          due: null,
          labels: [],
          is_completed: false,
          created_at: "t",
          url: "https://todoist.com/showTask?id=1",
          comment_count: 0,
          creator_id: "c1",
        },
      ];
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
      const created = {
        id: "9",
        content: "Ship it",
        description: "now",
        project_id: "p1",
        section_id: null,
        parent_id: null,
        order: 1,
        priority: 4,
        due: null,
        labels: ["Work"],
        is_completed: false,
        created_at: "t",
        url: "https://todoist.com/showTask?id=9",
        comment_count: 0,
        creator_id: "c1",
      };
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
      const projects = [
        {
          id: "p1",
          name: "Inbox",
          color: "grey",
          parent_id: null,
          order: 0,
          is_favorite: false,
          is_inbox_project: true,
          is_team_inbox: false,
          is_shared: false,
          url: "https://todoist.com/showProject?id=p1",
        },
      ];
      getProjects.mockResolvedValue(projects);

      const tool = getTool("todoist.list_projects");
      const out = await tool?.execute(ctx({}));

      expect(getProjects).toHaveBeenCalledWith();
      expect(out).toBe(JSON.stringify(projects));
    });
  });
});
