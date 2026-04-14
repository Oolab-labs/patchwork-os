import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createScreenshotAndAnnotateTool } from "../screenshotAndAnnotate.js";

function parse(r: { content: Array<{ text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

let workspace: string;

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "screenshot-annotate-"));
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function makeExtClient(connected = false) {
  return {
    isConnected: vi.fn().mockReturnValue(connected),
    getDiagnostics: vi.fn().mockResolvedValue([]),
  } as never;
}

describe("createScreenshotAndAnnotateTool", () => {
  it("returns required output fields", async () => {
    const tool = createScreenshotAndAnnotateTool(workspace, makeExtClient());
    const result = parse(await tool.handler({}));
    expect("targetUrl" in result).toBe(true);
    expect(Array.isArray(result.playwrightSteps)).toBe(true);
    expect(result.ideState).toBeDefined();
    expect(typeof result.ideState.errorCount).toBe("number");
    expect(typeof result.ideState.warningCount).toBe("number");
    expect(Array.isArray(result.ideState.changedFiles)).toBe(true);
  });

  it("targetUrl is null when no package.json and no explicit url", async () => {
    const tool = createScreenshotAndAnnotateTool(workspace, makeExtClient());
    const result = parse(await tool.handler({}));
    expect(result.targetUrl).toBeNull();
  });

  it("explicit url overrides package.json detection", async () => {
    const tool = createScreenshotAndAnnotateTool(workspace, makeExtClient());
    const result = parse(await tool.handler({ url: "http://localhost:9999" }));
    expect(result.targetUrl).toBe("http://localhost:9999");
  });

  it("detects vite URL from package.json scripts", async () => {
    fs.writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({ scripts: { dev: "vite" } }),
    );
    const tool = createScreenshotAndAnnotateTool(workspace, makeExtClient());
    const result = parse(await tool.handler({}));
    expect(result.targetUrl).toBe("http://localhost:5173");
    fs.rmSync(path.join(workspace, "package.json"));
  });

  it("detects next.js URL from package.json scripts", async () => {
    fs.writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({ scripts: { dev: "next dev" } }),
    );
    const tool = createScreenshotAndAnnotateTool(workspace, makeExtClient());
    const result = parse(await tool.handler({}));
    expect(result.targetUrl).toBe("http://localhost:3000");
    fs.rmSync(path.join(workspace, "package.json"));
  });

  it("detects explicit port from package.json dev script", async () => {
    fs.writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({ scripts: { dev: "vite --port 4321" } }),
    );
    const tool = createScreenshotAndAnnotateTool(workspace, makeExtClient());
    const result = parse(await tool.handler({}));
    expect(result.targetUrl).toBe("http://localhost:4321");
    fs.rmSync(path.join(workspace, "package.json"));
  });

  it("playwrightSteps includes navigate when targetUrl set", async () => {
    const tool = createScreenshotAndAnnotateTool(workspace, makeExtClient());
    const result = parse(await tool.handler({ url: "http://localhost:3000" }));
    const nav = result.playwrightSteps.find(
      (s: { tool: string }) => s.tool === "mcp__playwright__browser_navigate",
    );
    expect(nav).toBeDefined();
    expect(nav.params.url).toBe("http://localhost:3000");
  });

  it("playwrightSteps includes screenshot step always", async () => {
    const tool = createScreenshotAndAnnotateTool(workspace, makeExtClient());
    const result = parse(await tool.handler({}));
    const shot = result.playwrightSteps.find(
      (s: { tool: string }) =>
        s.tool === "mcp__playwright__browser_take_screenshot",
    );
    expect(shot).toBeDefined();
  });

  it("fullPage param is passed to screenshot step", async () => {
    const tool = createScreenshotAndAnnotateTool(workspace, makeExtClient());
    const result = parse(await tool.handler({ fullPage: true }));
    const shot = result.playwrightSteps.find(
      (s: { tool: string }) =>
        s.tool === "mcp__playwright__browser_take_screenshot",
    );
    expect(shot.params.fullPage).toBe(true);
  });

  it("includes waitForSelector step when provided", async () => {
    const tool = createScreenshotAndAnnotateTool(workspace, makeExtClient());
    const result = parse(
      await tool.handler({
        url: "http://localhost:3000",
        waitForSelector: "#app",
      }),
    );
    const waitStep = result.playwrightSteps.find(
      (s: { tool: string }) => s.tool === "mcp__playwright__browser_wait_for",
    );
    expect(waitStep).toBeDefined();
    expect(waitStep.params.selector).toBe("#app");
  });

  it("playwrightSteps are in ascending step order", async () => {
    const tool = createScreenshotAndAnnotateTool(workspace, makeExtClient());
    const result = parse(
      await tool.handler({
        url: "http://localhost:3000",
        waitForSelector: "#app",
      }),
    );
    const steps = result.playwrightSteps.map((s: { step: number }) => s.step);
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]).toBeGreaterThan(steps[i - 1]);
    }
  });

  it("diagnosticSummary reflects no errors when extension disconnected", async () => {
    const tool = createScreenshotAndAnnotateTool(
      workspace,
      makeExtClient(false),
    );
    const result = parse(await tool.handler({}));
    expect(result.ideState.errorCount).toBe(0);
    expect(result.ideState.warningCount).toBe(0);
    expect(result.ideState.diagnosticSummary).toContain("No diagnostics");
  });

  it("diagnostics from extension are counted when connected", async () => {
    const ext = {
      isConnected: vi.fn().mockReturnValue(true),
      getDiagnostics: vi.fn().mockResolvedValue([
        { severity: "error", message: "Oops" },
        { severity: "warning", message: "Watch out" },
        { severity: "warning", message: "Also this" },
      ]),
    } as never;
    const tool = createScreenshotAndAnnotateTool(workspace, ext);
    const result = parse(await tool.handler({}));
    expect(result.ideState.errorCount).toBe(1);
    expect(result.ideState.warningCount).toBe(2);
    expect(result.ideState.diagnosticSummary).toContain("1 error");
  });

  it("hint string includes diagnostic summary", async () => {
    const tool = createScreenshotAndAnnotateTool(workspace, makeExtClient());
    const result = parse(await tool.handler({}));
    expect(typeof result.hint).toBe("string");
    expect(result.hint.length).toBeGreaterThan(0);
  });
});
