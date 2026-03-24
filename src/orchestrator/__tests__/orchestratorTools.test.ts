import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildBridge } from "../childBridgeRegistry.js";
import type { OrchestratorConfig } from "../orchestratorConfig.js";
import { createOrchestratorTools } from "../orchestratorTools.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeConfig(
  overrides: Partial<OrchestratorConfig> = {},
): OrchestratorConfig {
  return {
    port: 4746,
    bindAddress: "127.0.0.1",
    lockDir: "/tmp/test-locks",
    healthIntervalMs: 10_000,
    verbose: false,
    jsonl: false,
    ...overrides,
  };
}

function makeBridge(overrides: Partial<ChildBridge> = {}): ChildBridge {
  return {
    port: 4000,
    workspace: "/projects/ws",
    workspaceFolders: ["/projects/ws"],
    ideName: "VSCode",
    authToken: "token-a",
    pid: 1234,
    startedAt: Date.now() - 5000,
    healthy: true,
    lastCheckedAt: Date.now(),
    consecutiveFailures: 0,
    tools: [
      {
        name: "readFile",
        description: "Read a file",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    discoveredAt: Date.now() - 5000,
    warmingUp: false,
    ...overrides,
  };
}

function makeRegistry(
  bridges: ChildBridge[],
  rejected: Array<{ port: number; reason: string }> = [],
) {
  const bridgeMap = new Map<number, ChildBridge>(
    bridges.map((b) => [b.port, b]),
  );
  return {
    getAll: () => Array.from(bridgeMap.values()),
    getHealthy: () => Array.from(bridgeMap.values()).filter((b) => b.healthy),
    getWarmingUp: () =>
      Array.from(bridgeMap.values()).filter((b) => !b.healthy && b.warmingUp),
    get: (port: number) => bridgeMap.get(port),
    pickForWorkspace: (ws: string) =>
      Array.from(bridgeMap.values()).find(
        (b) => b.healthy && b.workspaceFolders.some((f) => ws.startsWith(f)),
      ) ?? null,
    pickBest: () =>
      Array.from(bridgeMap.values()).find((b) => b.healthy) ?? null,
    getDuplicateWorkspaces: () => {
      const byWs = new Map<string, ChildBridge[]>();
      for (const b of bridgeMap.values()) {
        if (!b.healthy) continue;
        const arr = byWs.get(b.workspace) ?? [];
        arr.push(b);
        byWs.set(b.workspace, arr);
      }
      const dupes = new Map<string, ChildBridge[]>();
      for (const [ws, arr] of byWs) {
        if (arr.length > 1) dupes.set(ws, arr);
      }
      return dupes;
    },
    getRejected: () => rejected,
  };
}

function makeDeps(
  bridges: ChildBridge[],
  rejected: Array<{ port: number; reason: string }> = [],
  overrides: Partial<Parameters<typeof createOrchestratorTools>[0]> = {},
) {
  const registry = makeRegistry(bridges, rejected);
  return {
    registry,
    config: makeConfig(),
    startedAt: Date.now() - 30_000,
    getActiveSessions: () => 2,
    setStickyBridge: vi.fn(),
    ...overrides,
  };
}

// ── getOrchestratorStatus ─────────────────────────────────────────────────────

describe("getOrchestratorStatus", () => {
  it("includes skippedLockFiles count from rejected list", async () => {
    const deps = makeDeps(
      [makeBridge()],
      [
        { port: 9999, reason: "isBridge !== true" },
        { port: 9998, reason: "orchestrator lock" },
      ],
    );
    const tools = createOrchestratorTools(deps as never);
    const tool = tools.find((t) => t.schema.name === "getOrchestratorStatus")!;
    const result = await tool.handler({});
    const text = (result as { content: [{ text: string }] }).content[0].text;
    const json = JSON.parse(text) as { skippedLockFiles: number };
    expect(json.skippedLockFiles).toBe(2);
  });

  it("includes activeSessions from getActiveSessions", async () => {
    const deps = makeDeps([makeBridge()]);
    const tools = createOrchestratorTools(deps as never);
    const tool = tools.find((t) => t.schema.name === "getOrchestratorStatus")!;
    const result = await tool.handler({});
    const text = (result as { content: [{ text: string }] }).content[0].text;
    const json = JSON.parse(text) as { activeSessions: number };
    expect(json.activeSessions).toBe(2);
  });

  it("includes warmingUp flag per bridge", async () => {
    const warmBridge = makeBridge({ healthy: false, warmingUp: true });
    const deps = makeDeps([warmBridge]);
    const tools = createOrchestratorTools(deps as never);
    const tool = tools.find((t) => t.schema.name === "getOrchestratorStatus")!;
    const result = await tool.handler({});
    const text = (result as { content: [{ text: string }] }).content[0].text;
    const json = JSON.parse(text) as {
      childBridges: Array<{ warmingUp: boolean }>;
    };
    expect(json.childBridges[0]!.warmingUp).toBe(true);
  });
});

// ── listBridges ───────────────────────────────────────────────────────────────

describe("listBridges", () => {
  it("shows rejected lock file section when rejections exist", async () => {
    const deps = makeDeps(
      [makeBridge()],
      [{ port: 9001, reason: "known non-bridge IDE: JetBrains" }],
    );
    const tools = createOrchestratorTools(deps as never);
    const tool = tools.find((t) => t.schema.name === "listBridges")!;
    const result = await tool.handler({});
    const text = (result as { content: [{ text: string }] }).content[0].text;
    expect(text).toContain("Skipped lock files");
    expect(text).toContain("port 9001");
    expect(text).toContain("JetBrains");
  });

  it("omits rejected section when no rejections", async () => {
    const deps = makeDeps([makeBridge()]);
    const tools = createOrchestratorTools(deps as never);
    const tool = tools.find((t) => t.schema.name === "listBridges")!;
    const result = await tool.handler({});
    const text = (result as { content: [{ text: string }] }).content[0].text;
    expect(text).not.toContain("Skipped lock files");
  });

  it("shows no-bridges message when registry is empty", async () => {
    const deps = makeDeps([]);
    const tools = createOrchestratorTools(deps as never);
    const tool = tools.find((t) => t.schema.name === "listBridges")!;
    const result = await tool.handler({});
    const text = (result as { content: [{ text: string }] }).content[0].text;
    expect(text).toContain("No child bridges found");
  });

  it("includes warmingUp field in bridge listing", async () => {
    const warmBridge = makeBridge({ healthy: false, warmingUp: true });
    const deps = makeDeps([warmBridge]);
    const tools = createOrchestratorTools(deps as never);
    const tool = tools.find((t) => t.schema.name === "listBridges")!;
    const result = await tool.handler({});
    const text = (result as { content: [{ text: string }] }).content[0].text;
    const parsed = JSON.parse(text.split("\n[INFO]")[0]!) as Array<{
      warmingUp: boolean;
    }>;
    expect(parsed[0]!.warmingUp).toBe(true);
  });
});

// ── switchWorkspace ───────────────────────────────────────────────────────────

describe("switchWorkspace", () => {
  it("switches successfully when workspace is unambiguous", async () => {
    const bridge = makeBridge({
      port: 4001,
      workspace: "/projects/alpha",
      workspaceFolders: ["/projects/alpha"],
    });
    const deps = makeDeps([bridge]);
    const tools = createOrchestratorTools(deps as never);
    const tool = tools.find((t) => t.schema.name === "switchWorkspace")!;
    const result = await tool.handler({
      workspace: "/projects/alpha",
    });
    const text = (result as { content: [{ text: string }] }).content[0].text;
    expect(text).toContain("Switched");
    expect(deps.setStickyBridge).toHaveBeenCalledWith(4001);
  });

  it("returns disambiguation message when same workspace open in 2 IDEs", async () => {
    const bridgeA = makeBridge({
      port: 4001,
      workspace: "/projects/shared",
      workspaceFolders: ["/projects/shared"],
      ideName: "VSCode",
    });
    const bridgeB = makeBridge({
      port: 4002,
      workspace: "/projects/shared",
      workspaceFolders: ["/projects/shared"],
      ideName: "Windsurf",
    });
    const deps = makeDeps([bridgeA, bridgeB]);
    const tools = createOrchestratorTools(deps as never);
    const tool = tools.find((t) => t.schema.name === "switchWorkspace")!;
    const result = await tool.handler({ workspace: "/projects/shared" });
    const text = (result as { content: [{ text: string }] }).content[0].text;
    expect(text).toContain("open in 2 IDE instances");
    expect(text).toContain("port");
    expect(text).toContain("switchWorkspace");
    expect(text).toContain("port");
  });

  it("switches directly when port arg provided", async () => {
    const bridge = makeBridge({
      port: 4005,
      workspace: "/projects/beta",
      workspaceFolders: ["/projects/beta"],
    });
    const deps = makeDeps([bridge]);
    const tools = createOrchestratorTools(deps as never);
    const tool = tools.find((t) => t.schema.name === "switchWorkspace")!;
    const result = await tool.handler({
      workspace: "/projects/beta",
      port: 4005,
    });
    const text = (result as { content: [{ text: string }] }).content[0].text;
    expect(text).toContain("Switched");
    expect(deps.setStickyBridge).toHaveBeenCalledWith(4005);
  });

  it("returns error when port arg points to unknown bridge", async () => {
    const deps = makeDeps([makeBridge({ port: 4001 })]);
    const tools = createOrchestratorTools(deps as never);
    const tool = tools.find((t) => t.schema.name === "switchWorkspace")!;
    const result = await tool.handler({ workspace: "/any", port: 9999 });
    const text = (result as { content: [{ text: string }] }).content[0].text;
    expect(text).toContain("No bridge found on port 9999");
  });

  it("returns error when port arg points to unhealthy bridge", async () => {
    const bridge = makeBridge({
      port: 4007,
      healthy: false,
      consecutiveFailures: 3,
    });
    const deps = makeDeps([bridge]);
    const tools = createOrchestratorTools(deps as never);
    const tool = tools.find((t) => t.schema.name === "switchWorkspace")!;
    const result = await tool.handler({
      workspace: "/projects/ws",
      port: 4007,
    });
    const text = (result as { content: [{ text: string }] }).content[0].text;
    expect(text).toContain("not healthy");
  });

  it("hints warming bridges when no healthy bridge found for workspace", async () => {
    const warm = makeBridge({
      port: 4008,
      healthy: false,
      warmingUp: true,
      workspace: "/projects/warm",
    });
    const deps = makeDeps([warm]);
    const tools = createOrchestratorTools(deps as never);
    const tool = tools.find((t) => t.schema.name === "switchWorkspace")!;
    const result = await tool.handler({ workspace: "/projects/other" });
    const text = (result as { content: [{ text: string }] }).content[0].text;
    expect(text).toContain("starting up");
  });
});

// ── listWorkspaces ────────────────────────────────────────────────────────────

describe("listWorkspaces", () => {
  it("shows no workspaces message when registry empty", async () => {
    const deps = makeDeps([]);
    const tools = createOrchestratorTools(deps as never);
    const tool = tools.find((t) => t.schema.name === "listWorkspaces")!;
    const result = await tool.handler({});
    const text = (result as { content: [{ text: string }] }).content[0].text;
    expect(text).toContain("No IDE workspaces");
  });

  it("lists healthy workspaces", async () => {
    const deps = makeDeps([
      makeBridge({
        workspace: "/projects/foo",
        workspaceFolders: ["/projects/foo"],
      }),
    ]);
    const tools = createOrchestratorTools(deps as never);
    const tool = tools.find((t) => t.schema.name === "listWorkspaces")!;
    const result = await tool.handler({});
    const text = (result as { content: [{ text: string }] }).content[0].text;
    expect(text).toContain("/projects/foo");
    expect(text).toContain("Available workspaces");
  });

  it("annotates duplicate workspace with WARNING", async () => {
    const bridgeA = makeBridge({
      port: 4010,
      workspace: "/projects/shared",
      workspaceFolders: ["/projects/shared"],
      ideName: "VSCode",
    });
    const bridgeB = makeBridge({
      port: 4011,
      workspace: "/projects/shared",
      workspaceFolders: ["/projects/shared"],
      ideName: "Windsurf",
    });
    const deps = makeDeps([bridgeA, bridgeB]);
    const tools = createOrchestratorTools(deps as never);
    const tool = tools.find((t) => t.schema.name === "listWorkspaces")!;
    const result = await tool.handler({});
    const text = (result as { content: [{ text: string }] }).content[0].text;
    expect(text).toContain("WARNING");
    expect(text).toContain("same workspace also open");
  });

  it("shows warming bridges in starting-up section", async () => {
    const warm = makeBridge({
      port: 4012,
      healthy: false,
      warmingUp: true,
      workspace: "/projects/new",
    });
    const deps = makeDeps([warm]);
    const tools = createOrchestratorTools(deps as never);
    const tool = tools.find((t) => t.schema.name === "listWorkspaces")!;
    const result = await tool.handler({});
    const text = (result as { content: [{ text: string }] }).content[0].text;
    expect(text).toContain("Starting up");
    expect(text).toContain("/projects/new");
  });

  it("includes port disambiguation hint when duplicates present", async () => {
    const bridgeA = makeBridge({
      port: 4013,
      workspace: "/dup",
      workspaceFolders: ["/dup"],
      ideName: "VSCode",
    });
    const bridgeB = makeBridge({
      port: 4014,
      workspace: "/dup",
      workspaceFolders: ["/dup"],
      ideName: "Cursor",
    });
    const deps = makeDeps([bridgeA, bridgeB]);
    const tools = createOrchestratorTools(deps as never);
    const tool = tools.find((t) => t.schema.name === "listWorkspaces")!;
    const result = await tool.handler({});
    const text = (result as { content: [{ text: string }] }).content[0].text;
    expect(text).toContain("port argument");
  });
});
