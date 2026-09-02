/**
 * Phase 0 acceptance — scenario 5: the kill switch is universal.
 *
 *   (a) engaged MID-RUN by a step: the NEXT write step is refused
 *       (`kill_switch_blocked`) and the run halts;
 *   (b) an MCP write tool call is refused at the transport;
 *   (c) a QUEUED orchestrator task never starts once the switch is engaged;
 *   (d) governed + unreadable switch state refuses a recipe write.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

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

import { ClaudeOrchestrator } from "../../claudeOrchestrator.js";
import type { ProviderDriver } from "../../drivers/types.js";
import { KILL_SWITCH_WRITES, setFlag } from "../../featureFlags.js";
import { _setKillSwitchReaderForTesting } from "../../governance/killSwitchPolicy.js";
import { Logger } from "../../logger.js";
import { runYamlRecipe, type YamlRecipe } from "../../recipes/yamlRunner.js";
import { McpTransport } from "../../transport.js";
import {
  baseDeps,
  governed,
  makeSandbox,
  recordingApproval,
  registerFakeTool,
  resetGovernanceState,
} from "./_harness.js";

const sandbox = makeSandbox("killswitch");
afterAll(() => sandbox.dispose());

function recipe(): YamlRecipe {
  return {
    name: "flip-then-write",
    trigger: { type: "manual" },
    steps: [
      { tool: "test.write", into: "first" },
      { tool: "test.flip", into: "flipped" },
      { tool: "test.write", into: "second" },
      { tool: "test.read", into: "after" },
    ],
  } as unknown as YamlRecipe;
}

function tools() {
  const write = registerFakeTool({
    id: "test.write",
    isWrite: true,
    riskDefault: "high",
    execute: async () => "wrote",
  });
  const flip = registerFakeTool({
    id: "test.flip",
    isWrite: false,
    execute: async () => {
      setFlag(KILL_SWITCH_WRITES, true);
      return "engaged";
    },
  });
  const read = registerFakeTool({
    id: "test.read",
    isWrite: false,
    execute: async () => "read",
  });
  return { write, flip, read };
}

describe("scenario 5a — switch engaged between steps of a governed run", () => {
  beforeEach(resetGovernanceState);
  afterEach(resetGovernanceState);

  it("the next write is refused with kill_switch_blocked, the run halts, and no later step runs", async () => {
    const profile = governed();
    const { write, flip, read } = tools();
    const approval = recordingApproval(() => true);
    const result = await runYamlRecipe(
      recipe(),
      baseDeps(sandbox, {
        governance: profile,
        requireApprovalFn: approval.fn,
      }),
    );
    expect(write).toHaveBeenCalledTimes(1); // the first write, before the flip
    expect(flip).toHaveBeenCalledTimes(1);
    const second = result.stepResults.find((s) => s.id === "second");
    expect(second?.status).toBe("error");
    expect(second?.error).toMatch(/kill_switch_blocked/);
    expect(second?.haltCategory).toBe("kill_switch");
    expect(read).not.toHaveBeenCalled();
    expect(result.errorMessage).toMatch(/kill_switch_blocked/);
    // The approval gate was never asked about the refused write — the
    // switch is absolute, not a request for a human.
    expect(
      approval.calls.filter((c) => c.toolId === "test.write"),
    ).toHaveLength(1);
  });

  it("governed + unreadable switch state refuses the write before dispatch", async () => {
    const profile = governed();
    const { write } = tools();
    _setKillSwitchReaderForTesting(() => {
      throw new Error("flags.json unreadable");
    });
    const approval = recordingApproval(() => true);
    const result = await runYamlRecipe(
      { ...recipe(), steps: [{ tool: "test.write", into: "w" }] } as YamlRecipe,
      baseDeps(sandbox, {
        governance: profile,
        requireApprovalFn: approval.fn,
      }),
    );
    expect(write).not.toHaveBeenCalled();
    const w = result.stepResults.find((s) => s.id === "w");
    expect(w?.haltCategory).toBe("kill_switch");
    expect(w?.error).toMatch(/kill_switch_blocked/);
    expect(w?.error).toMatch(/unreadable/);
  });
});

// ── (b) MCP transport ────────────────────────────────────────────────────────

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
  transport.registerTool(
    {
      name: "gitPush",
      description: "write tool",
      inputSchema: { type: "object", properties: {} },
    },
    pushHandler,
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
  return { ws, send, pushHandler };
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

describe("scenario 5b — MCP write tool call while engaged", () => {
  beforeEach(resetGovernanceState);
  afterEach(resetGovernanceState);

  it("is refused at the transport and the handler never runs", async () => {
    governed();
    const t = setupTransport();
    // Engage AFTER the session is up — the switch must bite live sessions.
    setFlag(KILL_SWITCH_WRITES, true);
    t.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "gitPush", arguments: {} },
    });
    const reply = await waitForReply(t.ws, 1);
    const result = reply.result as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("kill_switch_blocked");
    expect(t.pushHandler).not.toHaveBeenCalled();
  });
});

// ── (c) orchestrator ─────────────────────────────────────────────────────────

describe("scenario 5c — a queued orchestrator task", () => {
  beforeEach(resetGovernanceState);
  afterEach(resetGovernanceState);

  it("never starts once the switch is engaged; already-running tasks finish", async () => {
    governed();
    const releasers: Array<() => void> = [];
    let runs = 0;
    const blocking: ProviderDriver = {
      name: "blocking",
      run: () =>
        new Promise((resolve) => {
          runs++;
          releasers.push(() =>
            resolve({ text: "ok", exitCode: 0, durationMs: 1 }),
          );
        }),
    };
    const orch = new ClaudeOrchestrator(blocking, sandbox.dir, () => {});
    const ids: string[] = [];
    for (let i = 0; i < ClaudeOrchestrator.MAX_CONCURRENT; i++) {
      ids.push(orch.enqueue({ prompt: `filler${i}` }));
    }
    const queued = orch.enqueue({ prompt: "queued" });
    expect(orch.getTask(queued)?.status).toBe("pending");
    const runsBefore = runs;
    setFlag(KILL_SWITCH_WRITES, true);
    for (const r of releasers) r();
    await new Promise((r) => setTimeout(r, 20));
    for (const id of ids) expect(orch.getTask(id)?.status).toBe("done");
    expect(orch.getTask(queued)?.status).toBe("error");
    expect(orch.getTask(queued)?.errorMessage).toMatch(/^kill_switch_blocked/);
    expect(runs).toBe(runsBefore); // the queued task's driver never ran
  });
});
