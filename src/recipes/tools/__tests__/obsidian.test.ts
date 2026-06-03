/**
 * Obsidian recipe-step tool tests.
 *
 * Mocks the obsidian connector module so each tool's `execute` can be driven
 * without a running Local REST API plugin, then fetches each registered tool
 * from the recipe tool registry by id and asserts:
 *   - the correct connector method is called with faithfully-mirrored args,
 *   - the JSON-stringified connector result is returned,
 *   - read/write + risk metadata is what the registry advertises.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// ── Connector mock ────────────────────────────────────────────────────────────
// The tool module `await import("../../connectors/obsidian.js")` lazily, so the
// mock must be hoisted (vi.mock is hoisted automatically) and expose
// getObsidianConnector returning an object of spies. Path is THREE levels up
// from this __tests__ directory.

const listVault = vi.fn();
const readNote = vi.fn();
const writeNote = vi.fn();
const searchVault = vi.fn();

vi.mock("../../../connectors/obsidian.js", () => ({
  getObsidianConnector: () => ({
    listVault,
    readNote,
    writeNote,
    searchVault,
  }),
}));

// Import AFTER the mock is declared so the self-registering module picks it up.
import "../obsidian.js";
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

describe("obsidian recipe-step tools", () => {
  describe("obsidian.list_vault", () => {
    it("is registered read-only / low risk", () => {
      const tool = getTool("obsidian.list_vault");
      expect(tool).toBeDefined();
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls listVault(vaultPath) and returns its JSON", async () => {
      const result = [
        { path: "Notes/", type: "directory" },
        { path: "Notes/idea.md", type: "file" },
      ];
      listVault.mockResolvedValue(result);

      const tool = getTool("obsidian.list_vault");
      const out = await tool?.execute(ctx({ vaultPath: "Notes" }));

      expect(listVault).toHaveBeenCalledWith("Notes");
      expect(out).toBe(JSON.stringify(result));
    });

    it("passes undefined when vaultPath is omitted", async () => {
      listVault.mockResolvedValue([]);
      const tool = getTool("obsidian.list_vault");
      await tool?.execute(ctx({}));

      expect(listVault).toHaveBeenCalledWith(undefined);
    });
  });

  describe("obsidian.read_note", () => {
    it("is registered read-only / low risk", () => {
      const tool = getTool("obsidian.read_note");
      expect(tool).toBeDefined();
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls readNote(notePath) and returns its JSON string", async () => {
      const content = "# Idea\n\nSome markdown body.";
      readNote.mockResolvedValue(content);

      const tool = getTool("obsidian.read_note");
      const out = await tool?.execute(ctx({ notePath: "Notes/idea.md" }));

      expect(readNote).toHaveBeenCalledWith("Notes/idea.md");
      expect(out).toBe(JSON.stringify(content));
    });
  });

  describe("obsidian.write_note", () => {
    it("is registered as a write / medium risk tool", () => {
      const tool = getTool("obsidian.write_note");
      expect(tool).toBeDefined();
      expect(tool?.isWrite).toBe(true);
      expect(tool?.riskDefault).toBe("medium");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls writeNote(notePath, content, false) by default", async () => {
      writeNote.mockResolvedValue(undefined);

      const tool = getTool("obsidian.write_note");
      const out = await tool?.execute(
        ctx({ notePath: "Notes/new.md", content: "hello" }),
      );

      expect(writeNote).toHaveBeenCalledWith("Notes/new.md", "hello", false);
      expect(out).toBe(
        JSON.stringify({ ok: true, path: "Notes/new.md", append: false }),
      );
    });

    it("passes append: true through to writeNote", async () => {
      writeNote.mockResolvedValue(undefined);

      const tool = getTool("obsidian.write_note");
      const out = await tool?.execute(
        ctx({ notePath: "Notes/log.md", content: "more", append: true }),
      );

      expect(writeNote).toHaveBeenCalledWith("Notes/log.md", "more", true);
      expect(out).toBe(
        JSON.stringify({ ok: true, path: "Notes/log.md", append: true }),
      );
    });
  });

  describe("obsidian.search_vault", () => {
    it("is registered read-only / low risk", () => {
      const tool = getTool("obsidian.search_vault");
      expect(tool).toBeDefined();
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls searchVault(query) and returns its JSON", async () => {
      const result = [
        { filename: "Notes/idea.md", score: 0.9, matches: ["idea"] },
      ];
      searchVault.mockResolvedValue(result);

      const tool = getTool("obsidian.search_vault");
      const out = await tool?.execute(ctx({ query: "idea" }));

      expect(searchVault).toHaveBeenCalledWith("idea");
      expect(out).toBe(JSON.stringify(result));
    });
  });
});
