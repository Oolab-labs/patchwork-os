import { describe, expect, it, vi } from "vitest";
import { createGetToolCapabilitiesTool } from "../getToolCapabilities.js";

function makeClient(connected: boolean) {
  return { isConnected: vi.fn(() => connected) } as any;
}

const fullProbes = {
  rg: true, fd: true, git: true, gh: true, codex: false,
  tsc: true, eslint: true, pyright: true, ruff: true, cargo: true, go: true, biome: true,
  prettier: true, black: true, gofmt: true, rustfmt: true,
  vitest: true, jest: true, pytest: true,
  node: true, npm: true, npx: true,
} as any;

const minimalProbes = {
  rg: false, fd: false, git: false, gh: false, codex: false,
  tsc: false, eslint: false, pyright: false, ruff: false, cargo: false, go: false, biome: false,
  prettier: false, black: false, gofmt: false, rustfmt: false,
  vitest: false, jest: false, pytest: false,
  node: false, npm: false, npx: false,
} as any;

const cfg = (editorCommand: string | null = null) => ({
  workspace: "/ws",
  workspaceFolders: [],
  ideName: "Test",
  editorCommand,
  port: null,
  bindAddress: "127.0.0.1",
  verbose: false,
  jsonl: false,
  linters: [],
  commandAllowlist: ["npm"],
  commandTimeout: 30_000,
  maxResultSize: 512,
  vscodeCommandAllowlist: [],
  activeWorkspaceFolder: "/ws",
  gracePeriodMs: 30_000,
  autoTmux: false,
} as any);

function parse(r: { content: Array<{ text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

describe("createGetToolCapabilitiesTool — extension connected", () => {
  it("returns extensionConnected:true and full feature set", async () => {
    const tool = createGetToolCapabilitiesTool(fullProbes, makeClient(true), cfg());
    const data = parse(await tool.handler());
    expect(data.extensionConnected).toBe(true);
    expect(data.features.fileOps).toContain("VS Code");
    expect(data.features.lsp).toContain("VS Code LSP");
    expect(data.features.terminalOutput).toContain("available");
    expect(data.features.selection).toBe("available");
    expect(data.features.dirtyCheck).toBe("real-time");
  });

  it("includes terminal and debug tools when connected", async () => {
    const tool = createGetToolCapabilitiesTool(fullProbes, makeClient(true), cfg());
    const data = parse(await tool.handler());
    expect(data.availableTools.terminal).toContain("listTerminals");
    expect(data.availableTools.debug).toContain("getDebugState");
  });

  it("includes watchFiles and organizeImports when connected", async () => {
    const tool = createGetToolCapabilitiesTool(fullProbes, makeClient(true), cfg());
    const data = parse(await tool.handler());
    expect(data.availableTools.files).toContain("watchFiles");
    expect(data.availableTools.editing).toContain("organizeImports");
  });

  it("includes github tools when gh probe is true", async () => {
    const tool = createGetToolCapabilitiesTool(fullProbes, makeClient(true), cfg());
    const data = parse(await tool.handler());
    expect(data.availableTools.github).toContain("githubCreatePR");
  });
});

describe("createGetToolCapabilitiesTool — extension disconnected", () => {
  it("returns extensionConnected:false and partial feature set", async () => {
    const tool = createGetToolCapabilitiesTool(minimalProbes, makeClient(false), cfg());
    const data = parse(await tool.handler());
    expect(data.extensionConnected).toBe(false);
    expect(data.features.fileOps).toContain("native fs fallback");
    expect(data.features.lsp).toContain("grep fallback");
    expect(data.features.terminalOutput).toContain("unavailable");
    expect(data.features.selection).toBe("stub-only");
    expect(data.features.dirtyCheck).toBe("mtime-heuristic");
  });

  it("returns empty terminal and debug arrays when disconnected", async () => {
    const tool = createGetToolCapabilitiesTool(minimalProbes, makeClient(false), cfg());
    const data = parse(await tool.handler());
    expect(data.availableTools.terminal).toEqual([]);
    expect(data.availableTools.debug).toEqual([]);
  });

  it("omits github key when gh probe is false", async () => {
    const tool = createGetToolCapabilitiesTool(minimalProbes, makeClient(false), cfg());
    const data = parse(await tool.handler());
    expect(data.availableTools.github).toBeUndefined();
  });

  it("shows editor-cli-reopen save when editorCommand is set", async () => {
    const tool = createGetToolCapabilitiesTool(minimalProbes, makeClient(false), cfg("cursor"));
    const data = parse(await tool.handler());
    expect(data.features.save).toContain("editor-cli-reopen");
  });

  it("shows no-op save when editorCommand is null and extension disconnected", async () => {
    const tool = createGetToolCapabilitiesTool(minimalProbes, makeClient(false), cfg(null));
    const data = parse(await tool.handler());
    expect(data.features.save).toContain("no-op");
  });

  it("reports diagnostics unavailable when all linters missing and disconnected", async () => {
    const tool = createGetToolCapabilitiesTool(minimalProbes, makeClient(false), cfg());
    const data = parse(await tool.handler());
    expect(data.features.diagnostics).toBe("unavailable");
  });

  it("reports diagnostics available when at least one linter present", async () => {
    const probes = { ...minimalProbes, tsc: true };
    const tool = createGetToolCapabilitiesTool(probes, makeClient(false), cfg());
    const data = parse(await tool.handler());
    expect(data.features.diagnostics).toBe("available");
  });

  it("reports fileSearch as fd when fd probe present", async () => {
    const probes = { ...minimalProbes, fd: true };
    const tool = createGetToolCapabilitiesTool(probes, makeClient(false), cfg());
    const data = parse(await tool.handler());
    expect(data.features.fileSearch).toBe("fd");
  });

  it("reports fileSearch as git-ls-files when git present but not fd", async () => {
    const probes = { ...minimalProbes, git: true };
    const tool = createGetToolCapabilitiesTool(probes, makeClient(false), cfg());
    const data = parse(await tool.handler());
    expect(data.features.fileSearch).toBe("git-ls-files");
  });

  it("reports fileSearch as find-fallback when neither fd nor git", async () => {
    const tool = createGetToolCapabilitiesTool(minimalProbes, makeClient(false), cfg());
    const data = parse(await tool.handler());
    expect(data.features.fileSearch).toBe("find-fallback");
  });

  it("reports search as rg when rg probe present", async () => {
    const probes = { ...minimalProbes, rg: true };
    const tool = createGetToolCapabilitiesTool(probes, makeClient(false), cfg());
    const data = parse(await tool.handler());
    expect(data.features.search).toBe("rg");
  });

  it("reports search as grep-fallback when rg absent", async () => {
    const tool = createGetToolCapabilitiesTool(minimalProbes, makeClient(false), cfg());
    const data = parse(await tool.handler());
    expect(data.features.search).toBe("grep-fallback");
  });
});
