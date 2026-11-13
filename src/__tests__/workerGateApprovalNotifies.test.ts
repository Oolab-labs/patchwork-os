/**
 * An approval raised FOR A WORKER must reach a person.
 *
 * `recipeApprovalNotifies.test.ts` records the defect and its first two fixes:
 * `queue.request()` queues silently, `enqueueApprovalWithDispatch` queues AND
 * fans out to the configured channels (webhook, Web Push, ntfy), and the fix
 * that moved callers onto the second has now missed a caller twice. The CLI
 * gate was first, the recipe tier gate (`makeRecipeApprovalFn`) second.
 *
 * This is the third: the worker-gate branch of `buildWorkerAutonomyGate`. It
 * is the branch that runs whenever worker autonomy is on — which the governed
 * profile turns on — and it called `queue.request()` directly. It was also
 * never handed the server's channel settings, so there was nothing for it to
 * dispatch to even had it tried. A worker's gated action therefore halted the
 * run, told nobody, expired, and the run failed: a stalled worker that looks
 * exactly like a broken one.
 *
 * These tests drive the REAL entry point (`RecipeOrchestration.fireYamlRecipe`)
 * rather than calling the gate with hand-injected channel settings. The
 * sibling failure is a call site that stops passing the settings: every
 * channel is then undefined at runtime and the path is silent again, while a
 * test that injects them itself keeps passing. Only the wired path can see it.
 *
 * What is observed is the last hop: an outbound send to each configured
 * channel. DNS is stubbed and `fetch` is replaced, so nothing leaves the
 * process. Every name, host, token and recipe here is synthetic.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// The notification senders resolve DNS before sending (pinnedSend) and refuse
// an unresolvable name. Answer every lookup with one public address so the
// synthetic hosts below get as far as the (replaced) fetch.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
}));

import {
  getApprovalQueue,
  resetApprovalQueueForTests,
} from "../approvalQueue.js";
import {
  FLAG_ENFORCE_POLICY,
  FLAG_WORKER_AUTONOMY,
  setFlag,
} from "../featureFlags.js";
import {
  _resetActiveProfileForTesting,
  resolveProfile,
  setActiveProfile,
} from "../governance/profile.js";
import { clearConfigCache } from "../patchworkConfig.js";
import { RecipeOrchestration } from "../recipeOrchestration.js";
import {
  hasTool,
  type RegisteredTool,
  registerTool,
} from "../recipes/toolRegistry.js";
import { loadYamlRecipe } from "../recipes/yamlRunner.js";
import { RecipeRunLog } from "../runLog.js";
import { WorkerGateDecisionLog } from "../workerGateDecisionLog.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * A write no worker manifest below owns and the action classifier does not
 * know: it classifies `other`, irreversible. An unearned, non-reversible
 * action is exactly what the worker gate hands to a person.
 */
const GATED_TOOL = "notifysink.push";
/** A high-tier write, for the control: the TIER gate queues this one. */
const HIGH_TOOL = "notifysink.escalate";
const RECIPE = "notify-probe";
const WORKER_NAME = "Notify Worker";

/** Every channel the bridge can be configured with, all set. */
const CHANNELS = {
  approvalWebhookUrl: "https://hooks.example.test/approvals",
  pushServiceUrl: "https://push.example.test",
  pushServiceToken: "synthetic-relay-token",
  pushServiceBaseUrl: "https://bridge.example.test",
  pushServiceAllowPrivate: false,
  ntfyTopic: "synthetic-topic",
  ntfyServer: "https://ntfy.example.test",
} as const;

/** Where each channel's send lands. */
const WEBHOOK_SEND = CHANNELS.approvalWebhookUrl;
const PUSH_SEND = `${CHANNELS.pushServiceUrl}/push`;
const NTFY_SEND = `${CHANNELS.ntfyServer}/`;

/**
 * The two ways worker autonomy gets switched on. The gate is the same code in
 * both; the governed row is here because that is the configuration in which
 * this path is on for everybody, not only for someone who set a flag.
 */
const MODES = [
  {
    label: "worker autonomy flag, compat profile",
    profile: "compat",
    approvalGate: "off",
    workerAutonomy: true,
  },
  {
    label: "governed profile",
    profile: "governed",
    approvalGate: "high",
    workerAutonomy: true,
  },
] as const;

/**
 * The control: worker autonomy OFF, so the only thing that can queue is the
 * tier gate (`makeRecipeApprovalFn`) — the path fixed on 2026-08-28.
 */
const TIER_ONLY = {
  label: "tier gate only",
  profile: "compat",
  approvalGate: "high",
  workerAutonomy: false,
} as const;
type Mode = (typeof MODES)[number] | typeof TIER_ONLY;

/** What the recipe does, and whether a worker owns it. */
interface Fixture {
  tool: string;
  workerOwned: boolean;
}
const WORKER_OWNED: Fixture = { tool: GATED_TOOL, workerOwned: true };
const NOBODYS: Fixture = { tool: HIGH_TOOL, workerOwned: false };

interface Sent {
  url: string;
  body: Record<string, unknown>;
}

let gatedExec: ReturnType<typeof vi.fn>;
let highExec: ReturnType<typeof vi.fn>;
let home: string;
let ws: string;
let sent: Sent[];
const savedHome = process.env.PATCHWORK_HOME;
const realFetch = globalThis.fetch;

beforeAll(() => {
  if (hasTool(GATED_TOOL)) return;
  gatedExec = vi.fn(async () => "pushed");
  highExec = vi.fn(async () => "escalated");
  const synthetic = {
    namespace: "notifysink",
    description: "synthetic irreversible write",
    paramsSchema: { type: "object" },
    outputSchema: { type: "string" },
    isWrite: true,
  };
  registerTool({
    ...synthetic,
    id: GATED_TOOL,
    riskDefault: "low",
    execute: gatedExec as unknown as RegisteredTool["execute"],
  });
  registerTool({
    ...synthetic,
    id: HIGH_TOOL,
    riskDefault: "high",
    execute: highExec as unknown as RegisteredTool["execute"],
  });
});

function resetSeams() {
  setFlag(FLAG_WORKER_AUTONOMY, false, false);
  setFlag(FLAG_ENFORCE_POLICY, false, false);
  _resetActiveProfileForTesting();
  resetApprovalQueueForTests();
  clearConfigCache();
}

beforeEach(() => {
  resetSeams();
  home = mkdtempSync(path.join(os.tmpdir(), "worker-notify-"));
  ws = path.join(home, "ws");
  mkdirSync(ws, { recursive: true });
  mkdirSync(path.join(home, "recipes"), { recursive: true });
  mkdirSync(path.join(home, "workers"), { recursive: true });
  process.env.PATCHWORK_HOME = home;
  gatedExec.mockClear();
  highExec.mockClear();
  sent = [];
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    sent.push({
      url: String(url),
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}"),
    });
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetSeams();
  if (savedHome === undefined) delete process.env.PATCHWORK_HOME;
  else process.env.PATCHWORK_HOME = savedHome;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // A lingering handle makes this EBUSY on Windows; the OS reaps the dir.
  }
});

// ── Harness ─────────────────────────────────────────────────────────────────

function jsonl(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => r.kind !== "chain-start" && r.kind !== "rotation");
}

/**
 * How long to wait for an approval to appear, and then for its notices. Both
 * return the moment the thing happens, so on a passing run they cost
 * milliseconds; they are sized for a slow CI cell under coverage, and are only
 * ever used up when the thing never happens (which is the defect). Together
 * they stay inside the 15 s test timeout.
 */
const PENDING_BUDGET_MS = 8_000;
const SEND_BUDGET_MS = 5_000;

/** Poll until `probe` yields a value; `undefined` when the budget runs out. */
async function until<T>(
  probe: () => T | undefined,
  budgetMs: number,
): Promise<T | undefined> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const v = probe();
    if (v !== undefined) return v;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** What `Bridge` does at startup for the profile, reduced to what matters. */
function bridgeStartup(mode: Mode) {
  writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify(mode.profile === "governed" ? { profile: "governed" } : {}),
  );
  clearConfigCache();
  const profile = resolveProfile({
    profile: mode.profile,
    approvalGate: mode.approvalGate,
  });
  setActiveProfile(profile);
  // Governed implies both flags (bridge.ts). Under compat the operator set
  // the worker flag by hand, which is the first row of MODES.
  if (mode.workerAutonomy) {
    setFlag(FLAG_WORKER_AUTONOMY, true, mode.profile === "governed");
  }
  if (profile.mode === "governed") setFlag(FLAG_ENFORCE_POLICY, true);
}

function writeFixtures(fixture: Fixture) {
  if (fixture.workerOwned) {
    writeFileSync(
      path.join(home, "workers", "notify.worker.yaml"),
      `id: notify-worker\nname: ${WORKER_NAME}\nrecipe: ${RECIPE}\nowns:\n  - fs-write\nautonomyCeiling: 4\n`,
    );
  }
  const file = path.join(home, "recipes", `${RECIPE}.yaml`);
  // JSON is valid YAML, and avoids a hand-written serializer.
  writeFileSync(
    file,
    JSON.stringify(
      {
        name: RECIPE,
        description: "synthetic worker-notify recipe",
        trigger: { type: "manual" },
        allowWrites: [fixture.tool],
        steps: [{ tool: fixture.tool, into: "pushed" }],
      },
      null,
      2,
    ),
  );
  return file;
}

/**
 * Fire the recipe through the bridge's own dispatch and stop at the moment a
 * person is being waited on. `server` is what the bridge would hold: the
 * approval gate plus the channel settings.
 */
async function fireUntilWaitingOnAPerson(
  mode: Mode,
  channels: Record<string, unknown> = CHANNELS,
  fixture: Fixture = WORKER_OWNED,
) {
  bridgeStartup(mode);
  const file = writeFixtures(fixture);
  // Built BEFORE the gate: the singleton keeps whichever options created it.
  const queue = getApprovalQueue({ persistDir: home });
  const recipeOrchestrator = {
    loadRecipe: (f: string) => loadYamlRecipe(f),
    listRecipes: () => [],
    fire: async (req: {
      filePath: string;
      name: string;
      seedContext?: Record<string, string>;
      dispatchFn: (
        r: unknown,
        d: unknown,
        s?: Record<string, string>,
      ) => Promise<unknown>;
    }) => {
      const result = await req.dispatchFn(
        loadYamlRecipe(req.filePath),
        {},
        req.seedContext,
      );
      return {
        ok: true as const,
        taskId: `${req.name}-1`,
        name: req.name,
        result,
      };
    },
  };
  const ro = new RecipeOrchestration({
    server: { approvalGate: mode.approvalGate, ...channels } as never,
    getOrchestrator: () =>
      ({
        runAndWait: async () => ({ output: "unused", status: "done" }),
      }) as never,
    recipeOrchestrator: recipeOrchestrator as never,
    recipeRunLog: new RecipeRunLog({ dir: home }),
    workerGateDecisionLog: new WorkerGateDecisionLog({ dir: home }),
    workdir: ws,
    logger: {},
  });
  const run = ro.fireYamlRecipe({
    filePath: file,
    name: RECIPE,
    taskIdPrefix: "notify",
    triggerSourceSuffix: "notify",
    logLabel: RECIPE,
  });
  // `owned`: created by a live caller in this process, i.e. by this run.
  const pending = await until(
    () => queue.list().find((p) => p.owned && p.toolName === fixture.tool),
    PENDING_BUDGET_MS,
  );
  return { run, queue, pending };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("the tier gate, at the same entry point (the control)", () => {
  // Already notifying since 2026-08-28. It is here for two reasons: it proves
  // this harness can observe a notification from a recipe run at all — so a
  // worker-gate test that sees none is seeing a defect, not a blind harness —
  // and until now that fix had only a source-level test, no behavioural one.
  it("announces a recipe step's approval on every configured channel", async () => {
    const { run, queue, pending } = await fireUntilWaitingOnAPerson(
      TIER_ONLY,
      CHANNELS,
      NOBODYS,
    );
    try {
      expect(pending, "the tier gate queued nothing").toBeDefined();
      // The tier gate's request: no worker, so no worker summary.
      expect(pending?.sessionId).toBe("recipe");
      expect(pending?.summary ?? "").not.toContain(WORKER_NAME);
      expect(jsonl(path.join(home, "worker_gate_decisions.jsonl"))).toEqual([]);
      await until(() => (sent.length >= 3 ? true : undefined), SEND_BUDGET_MS);
      expect(sent.map((s) => s.url).sort()).toEqual(
        [WEBHOOK_SEND, PUSH_SEND, NTFY_SEND].sort(),
      );
    } finally {
      if (pending) queue.reject(pending.callId);
      await run;
    }
    expect(highExec).not.toHaveBeenCalled();
  });
});

describe.each(MODES)("a worker's gated action — $label", (mode) => {
  it("is queued for a person by the WORKER gate (the precondition)", async () => {
    // Not the defect — the setup. If this fails, the tests below would be
    // failing for the wrong reason: nothing reached the worker-gate queue
    // branch, so there was no approval to announce.
    const { run, queue, pending } = await fireUntilWaitingOnAPerson(mode);
    try {
      expect(pending, "the worker gate queued nothing").toBeDefined();
      expect(queue.list()).toHaveLength(1);
      expect(pending?.toolName).toBe(GATED_TOOL);
      // The worker gate's own summary — the tier gate writes none of this.
      expect(pending?.summary).toMatch(
        new RegExp(`^${WORKER_NAME} \\(other:irreversible:[a-z]+\\): `),
      );
      const gateRows = jsonl(
        path.join(home, "worker_gate_decisions.jsonl"),
      ).filter((r) => r.action === "gate");
      expect(gateRows).toHaveLength(1);
      expect(gateRows[0]?.toolName).toBe(GATED_TOOL);
    } finally {
      if (pending) queue.reject(pending.callId);
      await run;
    }
  });

  it("is announced on every configured channel", async () => {
    const { run, queue, pending } = await fireUntilWaitingOnAPerson(mode);
    try {
      expect(pending, "the worker gate queued nothing").toBeDefined();
      // The sends are fire-and-forget behind a DNS lookup; give them a
      // moment. On the defect this simply runs out — nothing was dispatched.
      await until(() => (sent.length >= 3 ? true : undefined), SEND_BUDGET_MS);
      expect(sent.map((s) => s.url).sort()).toEqual(
        [WEBHOOK_SEND, PUSH_SEND, NTFY_SEND].sort(),
      );
    } finally {
      if (pending) queue.reject(pending.callId);
      await run;
    }
  });

  it("says what is being asked, and of whom, in each notice", async () => {
    const { run, queue, pending } = await fireUntilWaitingOnAPerson(mode);
    try {
      expect(pending, "the worker gate queued nothing").toBeDefined();
      await until(() => (sent.length >= 3 ? true : undefined), SEND_BUDGET_MS);
      const by = (url: string) => sent.find((s) => s.url === url)?.body;

      // Webhook: the same approval, by id, with the worker's summary.
      expect(by(WEBHOOK_SEND)).toMatchObject({
        toolName: GATED_TOOL,
        callId: pending?.callId,
        summary: pending?.summary,
      });
      // Web Push: carries the single-use token the phone answers with, and
      // the callback base — both come from the channel settings, so a
      // setting that is not threaded through shows up here.
      const push = by(PUSH_SEND);
      expect(push).toMatchObject({
        toolName: GATED_TOOL,
        callId: pending?.callId,
        summary: pending?.summary,
        bridgeCallbackBase: CHANNELS.pushServiceBaseUrl,
      });
      expect(typeof push?.approvalToken).toBe("string");
      // ntfy: published to the configured topic, worker summary as the text.
      expect(by(NTFY_SEND)).toMatchObject({
        topic: CHANNELS.ntfyTopic,
        message: pending?.summary,
      });
    } finally {
      if (pending) queue.reject(pending.callId);
      await run;
    }
  });

  it("keeps the request it queues exactly as it was", async () => {
    // Routing through the dispatching helper must change WHO HEARS about the
    // approval and nothing about the approval itself.
    const { run, queue, pending } = await fireUntilWaitingOnAPerson(mode);
    try {
      expect(pending, "the worker gate queued nothing").toBeDefined();
      // "recipe", never a worker label: sessionId is part of the approved-
      // action identity and the runner revalidates with "recipe".
      expect(pending?.sessionId).toBe("recipe");
      expect(pending?.recipeName).toBe(RECIPE);
      // ADR-0025: the approval and the Decision Record that caused it carry
      // the same run id, or neither can be reached from the other.
      const gateRow = jsonl(
        path.join(home, "worker_gate_decisions.jsonl"),
      ).find((r) => r.action === "gate");
      expect(typeof pending?.correlationId).toBe("string");
      expect(pending?.correlationId).toBe(gateRow?.correlationId);
      // …and the durable request row says the same.
      const requestRow = jsonl(path.join(home, "approval_log.jsonl")).find(
        (r) => r.kind === "request",
      );
      expect(requestRow).toMatchObject({
        callId: pending?.callId,
        toolName: GATED_TOOL,
        sessionId: "recipe",
        recipeName: RECIPE,
        correlationId: pending?.correlationId,
        summary: pending?.summary,
      });
    } finally {
      if (pending) queue.reject(pending.callId);
      await run;
    }
  });

  it("runs the action once approved — the grant still matches", async () => {
    // The runner revalidates the grant against the action it is about to
    // dispatch, and refuses the step on a missing or mismatched one. This is
    // the end-to-end half: an approval that came back through the
    // dispatching helper still carries a grant the runner accepts. The
    // request's own fields are pinned by the test above, and a secret-bearing
    // action's precomputed identity by approvalIdentityDispatchBinding.test.ts
    // — this test alone would not notice either (found by mutation).
    const { run, queue, pending } = await fireUntilWaitingOnAPerson(mode);
    expect(pending, "the worker gate queued nothing").toBeDefined();
    expect(gatedExec).not.toHaveBeenCalled();
    if (pending) queue.approve(pending.callId);
    const result = await run;
    expect(result.ok).toBe(true);
    expect(gatedExec).toHaveBeenCalledTimes(1);
  });

  it("does not run the action when the person says no", async () => {
    const { run, queue, pending } = await fireUntilWaitingOnAPerson(mode);
    expect(pending, "the worker gate queued nothing").toBeDefined();
    if (pending) queue.reject(pending.callId);
    await run;
    expect(gatedExec).not.toHaveBeenCalled();
  });

  it("does not run the action when the approval expires", async () => {
    const { run, queue, pending } = await fireUntilWaitingOnAPerson(mode);
    expect(pending, "the worker gate queued nothing").toBeDefined();
    queue.clear(); // resolves what is pending as "expired"
    await run;
    expect(gatedExec).not.toHaveBeenCalled();
  });

  it("does not run the action when the approval is cancelled", async () => {
    const { run, queue, pending } = await fireUntilWaitingOnAPerson(mode);
    expect(pending, "the worker gate queued nothing").toBeDefined();
    if (pending) queue.cancel(pending.callId);
    await run;
    expect(gatedExec).not.toHaveBeenCalled();
  });
});

describe("a worker's gated action with no channel configured", () => {
  it("still queues, and sends nothing", async () => {
    // The other direction: dispatch is driven by the settings, not invented.
    const { run, queue, pending } = await fireUntilWaitingOnAPerson(
      MODES[0],
      {},
    );
    try {
      expect(pending, "the worker gate queued nothing").toBeDefined();
      await new Promise((r) => setTimeout(r, 100));
      expect(sent).toEqual([]);
    } finally {
      if (pending) queue.reject(pending.callId);
      await run;
    }
  });
});
