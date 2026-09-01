import os from "node:os";
import path from "node:path";
/**
 * Phase 0 Step 5 — the kill switch is UNIVERSAL.
 *
 * Invariant: if the kill switch is active, no Patchwork-mediated consequential
 * write occurs; under the governed profile an UNREADABLE kill-switch state
 * refuses. Covered dispatch points: MCP tool dispatch (transport.ts), the
 * subprocess orchestrator's pending→running transition, the recipe entry
 * points (`runRecipeFn` / `webhookFn`), and recipe `executeTool` — including
 * chained recipes and `retry:` re-dispatches, which funnel through it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeOrchestrator } from "../../claudeOrchestrator.js";
import type { ProviderDriver, ProviderTaskInput } from "../../drivers/types.js";
import { KILL_SWITCH_WRITES, setFlag } from "../../featureFlags.js";
import { Logger } from "../../logger.js";
import {
  clearRegistry,
  executeTool,
  registerPluginTools,
  registerTool,
} from "../../recipes/toolRegistry.js";
import type { RunContext, StepDeps } from "../../recipes/yamlRunner.js";
import { McpTransport } from "../../transport.js";
import { _setKillSwitchReaderForTesting } from "../killSwitchPolicy.js";
import {
  _resetActiveProfileForTesting,
  GOVERNED_PROFILE,
  setActiveProfile,
} from "../profile.js";

vi.mock("../../recipesHttp.js", () => ({
  listInstalledRecipes: vi.fn(),
  loadRecipeContent: vi.fn(),
  saveRecipeContent: vi.fn(),
  saveRecipe: vi.fn(),
  loadRecipePrompt: vi.fn().mockReturnValue({ prompt: "do it" }),
  findYamlRecipePath: vi.fn(),
  findWebhookRecipe: vi.fn(),
  renderWebhookPrompt: vi.fn(),
}));
vi.mock("../../patchworkConfig.js", () => ({
  loadConfig: vi.fn().mockReturnValue({}),
  saveConfig: vi.fn(),
  defaultConfigPath: path.join(os.tmpdir(), "patchwork.json"),
}));
vi.mock("../../activationMetrics.js", () => ({ recordRecipeRun: vi.fn() }));

const KILL_SWITCH_ENV = "PATCHWORK_FLAG_KILL_SWITCH_WRITES";
const throwingReader = () => {
  throw new Error("flags.json unreadable");
};

beforeEach(() => {
  delete process.env[KILL_SWITCH_ENV];
  setFlag(KILL_SWITCH_WRITES, false);
  _setKillSwitchReaderForTesting(null);
  _resetActiveProfileForTesting();
});
afterEach(() => {
  delete process.env[KILL_SWITCH_ENV];
  setFlag(KILL_SWITCH_WRITES, false);
  _setKillSwitchReaderForTesting(null);
  _resetActiveProfileForTesting();
  clearRegistry();
});

// ── (a) MCP dispatch ────────────────────────────────────────────────────────

interface McpMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

class MockWs {
  readyState = 1;
  sent: string[] = [];
  handlers: Record<string, (arg: unknown) => void> = {};
  on(event: string, fn: (arg: unknown) => void) {
    this.handlers[event] = fn;
    return this;
  }
  off(event: string) {
    delete this.handlers[event];
    return this;
  }
  removeListener(event: string) {
    delete this.handlers[event];
    return this;
  }
  send(data: string, cb?: (err?: Error) => void) {
    this.sent.push(data);
    if (cb) cb();
  }
  close() {
    this.readyState = 3;
  }
  ping() {}
  pong() {}
  addEventListener(event: string, fn: (arg: unknown) => void) {
    this.on(event, fn);
  }
  terminate() {
    this.close();
  }
}

function setupTransport() {
  const transport = new McpTransport(new Logger(false));
  const pushHandler = vi.fn(async () => ({
    content: [{ type: "text", text: "pushed" }],
  }));
  const statusHandler = vi.fn(async () => ({
    content: [{ type: "text", text: "clean" }],
  }));
  transport.registerTool(
    {
      name: "gitPush",
      description: "write tool",
      inputSchema: { type: "object", properties: {} },
    },
    pushHandler,
  );
  transport.registerTool(
    {
      name: "getGitStatus",
      description: "read tool",
      inputSchema: { type: "object", properties: {} },
    },
    statusHandler,
  );
  const ws = new MockWs();
  transport.attach(ws as unknown as import("ws").WebSocket);
  const send = (msg: McpMessage) =>
    ws.handlers.message?.(Buffer.from(JSON.stringify(msg)));
  send({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { transport, ws, send, pushHandler, statusHandler };
}

async function waitForReply(ws: MockWs, id: number): Promise<McpMessage> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    for (const raw of ws.sent) {
      const parsed = JSON.parse(raw) as McpMessage;
      if (parsed.id === id) return parsed;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for reply id=${id}`);
}

describe("MCP tool dispatch honours the kill switch", () => {
  it("refuses a write tool with isError kill_switch_blocked and releases in-flight slots", async () => {
    setFlag(KILL_SWITCH_WRITES, true);
    const t = setupTransport();
    t.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "gitPush", arguments: {} },
    });
    const reply = await waitForReply(t.ws, 1);
    expect(reply.error).toBeUndefined();
    const result = reply.result as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("kill_switch_blocked");
    expect(t.pushHandler).not.toHaveBeenCalled();
    const internals = t.transport as unknown as {
      inFlightControllers: Map<unknown, unknown>;
      inFlightToolNames: Map<unknown, unknown>;
      activeToolCalls: number;
    };
    expect(internals.inFlightControllers.size).toBe(0);
    expect(internals.inFlightToolNames.size).toBe(0);
    expect(internals.activeToolCalls).toBe(0);
  });

  it("still serves a read tool while engaged", async () => {
    setFlag(KILL_SWITCH_WRITES, true);
    const t = setupTransport();
    t.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "getGitStatus", arguments: {} },
    });
    const reply = await waitForReply(t.ws, 2);
    expect((reply.result as { isError?: boolean }).isError).toBeFalsy();
    expect(t.statusHandler).toHaveBeenCalledTimes(1);
  });

  it("serves the write tool when released", async () => {
    const t = setupTransport();
    t.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "gitPush", arguments: {} },
    });
    const reply = await waitForReply(t.ws, 3);
    expect((reply.result as { isError?: boolean }).isError).toBeFalsy();
    expect(t.pushHandler).toHaveBeenCalledTimes(1);
  });

  it("governed + unreadable state refuses a write; compat proceeds", async () => {
    _setKillSwitchReaderForTesting(throwingReader);
    setActiveProfile(GOVERNED_PROFILE);
    const g = setupTransport();
    g.send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "gitPush", arguments: {} },
    });
    const governed = await waitForReply(g.ws, 4);
    expect((governed.result as { isError?: boolean }).isError).toBe(true);
    expect(g.pushHandler).not.toHaveBeenCalled();

    _resetActiveProfileForTesting();
    const c = setupTransport();
    c.send({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "gitPush", arguments: {} },
    });
    const compat = await waitForReply(c.ws, 5);
    expect((compat.result as { isError?: boolean }).isError).toBeFalsy();
    expect(c.pushHandler).toHaveBeenCalledTimes(1);
  });
});

// ── (b) subprocess orchestrator ─────────────────────────────────────────────

function makeDriver(): { driver: ProviderDriver; runs: number } {
  const state = { runs: 0 };
  const driver: ProviderDriver = {
    name: "instant",
    async run(_input: ProviderTaskInput) {
      state.runs++;
      return { text: "ok", exitCode: 0, durationMs: 1 };
    },
  };
  return {
    driver,
    get runs() {
      return state.runs;
    },
  };
}

describe("ClaudeOrchestrator refuses to START a task while engaged", () => {
  it("lands the task in error with kill_switch_blocked and never calls the driver", async () => {
    setFlag(KILL_SWITCH_WRITES, true);
    const d = makeDriver();
    const orch = new ClaudeOrchestrator(d.driver, "/tmp", () => {});
    const id = orch.enqueue({ prompt: "hello" });
    await new Promise((r) => setImmediate(r));
    const task = orch.getTask(id);
    expect(task?.status).toBe("error");
    expect(task?.errorMessage).toMatch(/^kill_switch_blocked/);
    expect(d.runs).toBe(0);
  });

  it("refuses a job that was QUEUED before the switch was engaged", async () => {
    const releasers: Array<() => void> = [];
    const blocking: ProviderDriver = {
      name: "blocking",
      run: () =>
        new Promise((resolve) => {
          releasers.push(() =>
            resolve({ text: "ok", exitCode: 0, durationMs: 1 }),
          );
        }),
    };
    const orch = new ClaudeOrchestrator(blocking, "/tmp", () => {});
    const ids: string[] = [];
    for (let i = 0; i < ClaudeOrchestrator.MAX_CONCURRENT; i++) {
      ids.push(orch.enqueue({ prompt: `filler${i}` }));
    }
    const queued = orch.enqueue({ prompt: "queued" });
    expect(orch.getTask(queued)?.status).toBe("pending");
    setFlag(KILL_SWITCH_WRITES, true);
    // Running tasks are NOT killed — they complete normally.
    for (const r of releasers) r();
    await new Promise((r) => setTimeout(r, 20));
    for (const id of ids) expect(orch.getTask(id)?.status).toBe("done");
    expect(orch.getTask(queued)?.status).toBe("error");
    expect(orch.getTask(queued)?.errorMessage).toMatch(/^kill_switch_blocked/);
  });

  it("governed + unreadable state refuses; compat starts the task", async () => {
    _setKillSwitchReaderForTesting(throwingReader);
    setActiveProfile(GOVERNED_PROFILE);
    const g = makeDriver();
    const gov = new ClaudeOrchestrator(g.driver, "/tmp", () => {});
    const gid = gov.enqueue({ prompt: "x" });
    await new Promise((r) => setImmediate(r));
    expect(gov.getTask(gid)?.status).toBe("error");
    expect(g.runs).toBe(0);

    _resetActiveProfileForTesting();
    const c = makeDriver();
    const compat = new ClaudeOrchestrator(c.driver, "/tmp", () => {});
    const cid = compat.enqueue({ prompt: "x" });
    await new Promise((r) => setImmediate(r));
    expect(compat.getTask(cid)?.status).toBe("done");
    expect(c.runs).toBe(1);
  });
});

// ── (c) recipe entry points ─────────────────────────────────────────────────

describe("recipe entry points (runRecipeFn / webhookFn)", () => {
  async function wire() {
    const { RecipeOrchestration } = await import(
      "../../recipeOrchestration.js"
    );
    const server = {
      recipesFn: null as unknown,
      loadRecipeContentFn: null as unknown,
      saveRecipeContentFn: null as unknown,
      saveRecipeFn: null as unknown,
      setRecipeEnabledFn: null as unknown,
      runsFn: null as unknown,
      runDetailFn: null as unknown,
      runPlanFn: null as unknown,
      webhookFn: null as unknown,
      runRecipeFn: null as unknown,
    };
    const orchestrator = { enqueue: vi.fn().mockReturnValue("task-1") };
    const ro = new RecipeOrchestration({
      server,
      getOrchestrator: () => orchestrator,
      recipeOrchestrator: {
        fire: vi.fn().mockResolvedValue({ ok: true, taskId: "t1" }),
        loadRecipe: vi.fn().mockReturnValue({
          name: "foo",
          trigger: { type: "manual" },
          steps: [],
        }),
        isInFlight: vi.fn().mockReturnValue(false),
        listInFlight: vi.fn().mockReturnValue([]),
      },
      recipeRunLog: null,
      workdir: path.join(os.tmpdir(), "ws"),
      logger: {},
    } as never);
    ro.wireServerFns();
    return { server, orchestrator };
  }

  it("engaged switch refuses runRecipeFn and webhookFn with kill_switch_blocked", async () => {
    setFlag(KILL_SWITCH_WRITES, true);
    const { server, orchestrator } = await wire();
    const run = await (
      server.runRecipeFn as (
        n: string,
      ) => Promise<{ ok: boolean; error?: string }>
    )("foo");
    expect(run).toMatchObject({ ok: false, error: "kill_switch_blocked" });
    const hook = await (
      server.webhookFn as (
        p: string,
        b: unknown,
      ) => Promise<{ ok: boolean; error?: string }>
    )("/x", {});
    expect(hook).toMatchObject({ ok: false, error: "kill_switch_blocked" });
    expect(orchestrator.enqueue).not.toHaveBeenCalled();
  });

  it("governed + throwing reader refuses; compat proceeds past the gate", async () => {
    _setKillSwitchReaderForTesting(throwingReader);
    setActiveProfile(GOVERNED_PROFILE);
    const g = await wire();
    const governed = await (
      g.server.runRecipeFn as (
        n: string,
      ) => Promise<{ ok: boolean; error?: string }>
    )("foo");
    expect(governed).toMatchObject({ ok: false, error: "kill_switch_blocked" });

    _resetActiveProfileForTesting();
    const c = await wire();
    const compat = await (
      c.server.runRecipeFn as (
        n: string,
      ) => Promise<{ ok: boolean; error?: string }>
    )("foo");
    expect(compat.error).not.toBe("kill_switch_blocked");
  });
});

// ── (d) executeTool: governed fail-closed, plugin tools, chained, retry ──────

const dummyContext = {
  params: {},
  step: {},
  ctx: { env: {}, steps: {} } as unknown as RunContext,
  deps: {} as StepDeps,
};

function registerWrite(exec: () => Promise<string>) {
  registerTool({
    id: "test.write",
    namespace: "test",
    description: "w",
    paramsSchema: { type: "object" },
    outputSchema: { type: "string" },
    riskDefault: "high",
    isWrite: true,
    execute: exec,
  });
}

describe("executeTool under the governed profile", () => {
  it("refuses a write tool when the reader throws; compat runs it", async () => {
    const exec = vi.fn().mockResolvedValue("wrote");
    registerWrite(exec);
    _setKillSwitchReaderForTesting(throwingReader);
    setActiveProfile(GOVERNED_PROFILE);
    await expect(executeTool("test.write", dummyContext)).rejects.toMatchObject(
      {
        code: "kill_switch_blocked",
      },
    );
    expect(exec).not.toHaveBeenCalled();
    _resetActiveProfileForTesting();
    await expect(executeTool("test.write", dummyContext)).resolves.toBe(
      "wrote",
    );
  });

  it("gates a DESTRUCTIVE plugin tool (destructiveHint) and not a read-only one", async () => {
    const destructive = vi.fn().mockResolvedValue("deleted");
    const readonly = vi.fn().mockResolvedValue("listed");
    registerPluginTools([
      {
        name: "plug_delete",
        schema: {
          description: "d",
          inputSchema: {},
          annotations: { destructiveHint: true },
        },
        handler: destructive,
      },
      {
        name: "plug_list",
        schema: { description: "l", inputSchema: {} },
        handler: readonly,
      },
    ] as never);
    setFlag(KILL_SWITCH_WRITES, true);
    await expect(
      executeTool("plug_delete", dummyContext),
    ).rejects.toMatchObject({
      code: "kill_switch_blocked",
    });
    expect(destructive).not.toHaveBeenCalled();
    await expect(executeTool("plug_list", dummyContext)).resolves.toBe(
      "listed",
    );
  });

  it("a CHAINED recipe write is refused when engaged (funnels through executeTool)", async () => {
    const exec = vi.fn().mockResolvedValue("wrote");
    registerWrite(exec);
    setFlag(KILL_SWITCH_WRITES, true);
    const { runChainedRecipe } = await import("../../recipes/chainedRunner.js");
    const result = await runChainedRecipe(
      { name: "chained", steps: [{ id: "a", tool: "test.write" }] },
      { env: {}, maxConcurrency: 1, maxDepth: 1, dryRun: false },
      {
        executeTool: (tool, params) =>
          executeTool(tool, { ...dummyContext, params }),
        executeAgent: vi.fn(),
        loadNestedRecipe: vi.fn().mockResolvedValue(null),
      },
    );
    expect(result.success).toBe(false);
    expect(result.stepResults.get("a")?.error?.message ?? "").toMatch(
      /kill_switch_blocked/,
    );
    expect(exec).not.toHaveBeenCalled();
  });

  it("a `retry:` re-dispatch is refused too — every attempt hits executeTool", async () => {
    const exec = vi.fn().mockResolvedValue("wrote");
    registerWrite(exec);
    setFlag(KILL_SWITCH_WRITES, true);
    let dispatches = 0;
    const { runChainedRecipe } = await import("../../recipes/chainedRunner.js");
    const result = await runChainedRecipe(
      {
        name: "retrying",
        steps: [{ id: "a", tool: "test.write", retry: 2, retryDelay: 0 }],
      },
      { env: {}, maxConcurrency: 1, maxDepth: 1, dryRun: false },
      {
        executeTool: (tool, params) => {
          dispatches++;
          return executeTool(tool, { ...dummyContext, params });
        },
        executeAgent: vi.fn(),
        loadNestedRecipe: vi.fn().mockResolvedValue(null),
      },
    );
    expect(result.success).toBe(false);
    // The effective-policy pre-check refuses the step BEFORE the first
    // dispatch, so no attempt reaches executeTool at all — stronger than the
    // per-attempt refusal this test was first written against. The invariant
    // is the same either way: the write never executes.
    expect(dispatches).toBe(0);
    expect(result.stepResults.get("a")?.error?.message ?? "").toMatch(
      /kill_switch_blocked/,
    );
    expect(exec).not.toHaveBeenCalled();
  });
});
