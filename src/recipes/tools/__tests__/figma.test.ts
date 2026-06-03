/**
 * Figma recipe-step tool tests.
 *
 * Mocks the Figma connector module so each tool's `execute` can be driven
 * without network access, then fetches each registered tool from the recipe
 * tool registry by id and asserts:
 *   - the correct connector method is called with faithfully-mirrored args,
 *   - the JSON-stringified connector result is returned verbatim,
 *   - read + risk metadata is what the registry advertises.
 *
 * All v1 Figma tools are read-only.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// ── Connector mock ────────────────────────────────────────────────────────────
// The tool module `await import("../../connectors/figma.js")` lazily, so from
// this test file (in __tests__/) the path is THREE levels up. vi.mock is hoisted
// automatically; the factory exposes getFigmaConnector returning spies.

const getFile = vi.fn();
const getFileComments = vi.fn();
const listProjectFiles = vi.fn();
const getImageUrls = vi.fn();

vi.mock("../../../connectors/figma.js", () => ({
  getFigmaConnector: () => ({
    getFile,
    getFileComments,
    listProjectFiles,
    getImageUrls,
  }),
}));

// Import AFTER the mock is declared so the self-registering module picks it up.
import "../figma.js";
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

describe("figma recipe-step tools", () => {
  describe("figma.get_file", () => {
    it("is registered read-only / low risk / connector", () => {
      const tool = getTool("figma.get_file");
      expect(tool).toBeDefined();
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls getFile with mirrored params and returns its JSON", async () => {
      const result = {
        name: "Design System",
        lastModified: "2026-01-01T00:00:00Z",
        version: "12345",
        document: { id: "0:0", type: "DOCUMENT" },
      };
      getFile.mockResolvedValue(result);

      const tool = getTool("figma.get_file");
      const out = await tool?.execute(
        ctx({ fileKey: "abc123", depth: 3, geometry: "paths" }),
      );

      expect(getFile).toHaveBeenCalledWith("abc123", {
        depth: 3,
        geometry: "paths",
      });
      expect(out).toBe(JSON.stringify(result));
    });

    it("passes undefined for omitted optional params", async () => {
      getFile.mockResolvedValue({ name: "f" });
      const tool = getTool("figma.get_file");
      await tool?.execute(ctx({ fileKey: "abc123" }));

      expect(getFile).toHaveBeenCalledWith("abc123", {
        depth: undefined,
        geometry: undefined,
      });
    });

    it("drops an invalid geometry value", async () => {
      getFile.mockResolvedValue({ name: "f" });
      const tool = getTool("figma.get_file");
      await tool?.execute(ctx({ fileKey: "abc123", geometry: "bogus" }));

      expect(getFile).toHaveBeenCalledWith("abc123", {
        depth: undefined,
        geometry: undefined,
      });
    });
  });

  describe("figma.get_file_comments", () => {
    it("is registered read-only / low risk / connector", () => {
      const tool = getTool("figma.get_file_comments");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls getFileComments(fileKey) and returns its JSON", async () => {
      const result = {
        comments: [
          {
            id: "c1",
            file_key: "abc123",
            message: "Looks good",
            user: { id: "u1", handle: "casey" },
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      };
      getFileComments.mockResolvedValue(result);

      const tool = getTool("figma.get_file_comments");
      const out = await tool?.execute(ctx({ fileKey: "abc123" }));

      expect(getFileComments).toHaveBeenCalledWith("abc123");
      expect(out).toBe(JSON.stringify(result));
    });
  });

  describe("figma.list_project_files", () => {
    it("is registered read-only / low risk / connector", () => {
      const tool = getTool("figma.list_project_files");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls listProjectFiles(projectId) and returns its JSON", async () => {
      const result = {
        name: "Marketing",
        files: [
          {
            key: "abc123",
            name: "Landing Page",
            last_modified: "2026-01-01T00:00:00Z",
          },
        ],
      };
      listProjectFiles.mockResolvedValue(result);

      const tool = getTool("figma.list_project_files");
      const out = await tool?.execute(ctx({ projectId: "9876" }));

      expect(listProjectFiles).toHaveBeenCalledWith("9876");
      expect(out).toBe(JSON.stringify(result));
    });
  });

  describe("figma.get_image_urls", () => {
    it("is registered read-only / low risk / connector", () => {
      const tool = getTool("figma.get_image_urls");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls getImageUrls with mirrored params and returns its JSON", async () => {
      const result = {
        err: null,
        images: { "1:2": "https://figma-image.example/1.png" },
      };
      getImageUrls.mockResolvedValue(result);

      const tool = getTool("figma.get_image_urls");
      const out = await tool?.execute(
        ctx({
          fileKey: "abc123",
          ids: ["1:2", "3:4"],
          format: "svg",
          scale: 2,
        }),
      );

      expect(getImageUrls).toHaveBeenCalledWith("abc123", {
        ids: ["1:2", "3:4"],
        format: "svg",
        scale: 2,
      });
      expect(out).toBe(JSON.stringify(result));
    });

    it("passes undefined for omitted optional params", async () => {
      getImageUrls.mockResolvedValue({ err: null, images: {} });
      const tool = getTool("figma.get_image_urls");
      await tool?.execute(ctx({ fileKey: "abc123", ids: ["1:2"] }));

      expect(getImageUrls).toHaveBeenCalledWith("abc123", {
        ids: ["1:2"],
        format: undefined,
        scale: undefined,
      });
    });

    it("drops an invalid format value", async () => {
      getImageUrls.mockResolvedValue({ err: null, images: {} });
      const tool = getTool("figma.get_image_urls");
      await tool?.execute(
        ctx({ fileKey: "abc123", ids: ["1:2"], format: "tiff" }),
      );

      expect(getImageUrls).toHaveBeenCalledWith("abc123", {
        ids: ["1:2"],
        format: undefined,
        scale: undefined,
      });
    });
  });
});
