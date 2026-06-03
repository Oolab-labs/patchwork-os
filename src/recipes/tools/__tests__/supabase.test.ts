/**
 * Supabase recipe-step tools — storage list + schema read plus a storage upload
 * write.
 *
 * Mocks the Supabase connector module so the self-registering tool module can be
 * imported and each tool exercised through the registry without network or
 * stored credentials. Asserts faithful param mapping into the connector calls
 * and that the raw connector return type is JSON-stringified back out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTool } from "../../toolRegistry.js";
import type { RunContext, StepDeps } from "../../yamlRunner.js";

// ── Connector mock ───────────────────────────────────────────────────────────
// One shared connector object with spy methods. getSupabaseConnector returns it.

const listFiles = vi.fn();
const getSchema = vi.fn();
const uploadFile = vi.fn();

vi.mock("../../../connectors/supabase.js", () => ({
  getSupabaseConnector: () => ({
    listFiles,
    getSchema,
    uploadFile,
  }),
}));

// Importing the module self-registers the tools into the shared registry.
import "../supabase.js";

function makeContext(params: Record<string, unknown>) {
  return {
    params,
    step: {},
    ctx: { env: {}, steps: {} } as unknown as RunContext,
    deps: {} as StepDeps,
  };
}

describe("supabase recipe-step tools", () => {
  beforeEach(() => {
    listFiles.mockReset();
    getSchema.mockReset();
    uploadFile.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── registration metadata ──────────────────────────────────────────────────

  it("registers read tools as low risk / non-write", () => {
    for (const id of ["supabase.list_files", "supabase.get_schema"]) {
      const tool = getTool(id);
      expect(tool, `tool ${id} should be registered`).toBeDefined();
      expect(tool?.namespace).toBe("supabase");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
      expect(tool?.outputSchema).toBeDefined();
    }
  });

  it("registers upload_file as a medium-risk write tool", () => {
    const tool = getTool("supabase.upload_file");
    expect(tool).toBeDefined();
    expect(tool?.namespace).toBe("supabase");
    expect(tool?.isWrite).toBe(true);
    expect(tool?.riskDefault).toBe("medium");
    expect(tool?.isConnector).toBe(true);
    expect(tool?.outputSchema).toBeDefined();
  });

  // ── supabase.list_files ─────────────────────────────────────────────────────

  it("list_files forwards bucket/prefix/limit and stringifies the array", async () => {
    const objects = [
      {
        name: "logo.png",
        bucket_id: "assets",
        owner: "owner-1",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
        last_accessed_at: "2026-01-03T00:00:00Z",
        metadata: { size: 1024 },
      },
    ];
    listFiles.mockResolvedValue(objects);

    const tool = getTool("supabase.list_files");
    const out = await tool?.execute(
      makeContext({ bucket: "assets", prefix: "img/", limit: 25 }),
    );

    expect(listFiles).toHaveBeenCalledWith("assets", "img/", 25);
    expect(out).toBe(JSON.stringify(objects));
  });

  it("list_files passes undefined for omitted / wrong-typed prefix and limit", async () => {
    listFiles.mockResolvedValue([]);

    const tool = getTool("supabase.list_files");
    await tool?.execute(makeContext({ bucket: "assets", limit: "nope" }));

    expect(listFiles).toHaveBeenCalledWith("assets", undefined, undefined);
  });

  // ── supabase.get_schema ─────────────────────────────────────────────────────

  it("get_schema calls the connector with no args and stringifies the object", async () => {
    const schema = { swagger: "2.0", paths: { "/widgets": {} } };
    getSchema.mockResolvedValue(schema);

    const tool = getTool("supabase.get_schema");
    const out = await tool?.execute(makeContext({}));

    expect(getSchema).toHaveBeenCalledWith();
    expect(out).toBe(JSON.stringify(schema));
  });

  // ── supabase.upload_file ────────────────────────────────────────────────────

  it("upload_file forwards bucket/path/file/contentType and stringifies the object", async () => {
    const result = { Key: "assets/notes.txt", Id: "obj-1" };
    uploadFile.mockResolvedValue(result);

    const tool = getTool("supabase.upload_file");
    const out = await tool?.execute(
      makeContext({
        bucket: "assets",
        path: "notes.txt",
        file: "hello world",
        contentType: "text/plain",
      }),
    );

    expect(uploadFile).toHaveBeenCalledWith(
      "assets",
      "notes.txt",
      "hello world",
      "text/plain",
    );
    expect(out).toBe(JSON.stringify(result));
  });

  it("upload_file passes undefined contentType when omitted / wrong-typed", async () => {
    uploadFile.mockResolvedValue({});

    const tool = getTool("supabase.upload_file");
    await tool?.execute(
      makeContext({
        bucket: "assets",
        path: "notes.txt",
        file: "hello",
        contentType: 123,
      }),
    );

    expect(uploadFile).toHaveBeenCalledWith(
      "assets",
      "notes.txt",
      "hello",
      undefined,
    );
  });
});
