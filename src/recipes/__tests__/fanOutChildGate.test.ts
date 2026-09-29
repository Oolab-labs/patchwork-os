/**
 * A `fan_out` step is gated as the tool it runs per item, not as `fan_out`.
 *
 * `fan_out` is registered `isWrite: false` with no `riskDefault`, and its id
 * has no dot, so `classifyTool("fan_out")` falls to the "medium" default. The
 * approval gates classified the STEP's tool id, so under approvalGate "high" a
 * high-tier write wrapped in `fan_out` never reached a human, while the same
 * write as a direct step queued. Children dispatch through executeTool
 * directly, so `patchwork.policy.yml` was checked against `fan_out` and its
 * step params — never a child's own params — as well.
 *
 * The write tool is a registered fake whose execute() really POSTs to a
 * loopback server; the server's request count is the record of truth. The
 * approval doubles are faithful to makeRecipeApprovalFn under gate "high":
 * ALLOW passes, anything else is put to a "human" who refuses or approves with
 * a grant computed exactly as ApprovalQueue computes it, so the approve cases
 * also prove the identity binding still holds at dispatch.
 */
import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  baseDeps,
  compatHigh,
  governed,
  makeSandbox,
  registerFakeTool,
} from "../../__tests__/phase0/_harness.js";
import {
  type ApprovalGrant,
  computeApprovedActionIdentity,
} from "../../approvalIdentity.js";
import { FLAG_ENFORCE_POLICY, setFlag } from "../../featureFlags.js";
import { _resetActiveProfileForTesting } from "../../governance/profile.js";
import type { ApprovalRequestInput } from "../approvalRequest.js";
import { type ChainedRecipe, runChainedRecipe } from "../chainedRunner.js";
import { hasTool } from "../toolRegistry.js";
import {
  buildChainedDeps,
  type RunnerDeps,
  runYamlRecipe,
  type YamlRecipe,
} from "../yamlRunner.js";
import "../tools/fanOut.js";
import "../tools/file.js";

const target = {
  server: undefined as Server | undefined,
  url: "",
  dispatches: 0,
};
let sandbox: ReturnType<typeof makeSandbox>;
const TOOL = "fanouttest.create_record";

beforeAll(async () => {
  target.server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      target.dispatches++;
      res.writeHead(201);
      res.end("{}");
    });
  });
  await new Promise<void>((r) => target.server?.listen(0, "127.0.0.1", r));
  target.url = `http://127.0.0.1:${(target.server?.address() as AddressInfo).port}`;
});
/** Registered per test: the fake tool must exist in the registry each run. */
function registerTools() {
  if (hasTool(TOOL)) return;
  registerFakeTool({
    id: TOOL,
    isWrite: true,
    riskDefault: "high",
    execute: async ({ params }: { params: Record<string, unknown> }) => {
      await fetch(`${target.url}/records`, {
        method: "POST",
        body: JSON.stringify(params),
      });
      return JSON.stringify({ ok: true });
    },
  } as Parameters<typeof registerFakeTool>[0]);
}
afterAll(async () => {
  await new Promise<void>((r) => target.server?.close(() => r()));
});
beforeEach(() => {
  _resetActiveProfileForTesting();
  registerTools();
  target.dispatches = 0;
  sandbox = makeSandbox("fanout-child-gate");
});
afterEach(() => {
  setFlag(FLAG_ENFORCE_POLICY, false, false);
  _resetActiveProfileForTesting();
  sandbox.dispose();
});

/** A grant computed exactly as ApprovalQueue.request computes it. */
function genuineGrant(input: ApprovalRequestInput): {
  approved: true;
  grant: ApprovalGrant;
} {
  return {
    approved: true,
    grant: {
      decision: "approved",
      approvalId: "test-approval",
      approvedActionIdentity:
        input.proposedActionIdentity ??
        computeApprovedActionIdentity({
          toolName: input.toolId,
          params: input.params ?? {},
          sessionId: "recipe",
          tier: input.tier,
          correlationId: input.runTaskId,
          recipeName: input.recipeName,
        }),
      facts: {
        tier: input.tier,
        correlationId: input.runTaskId,
        recipeName: input.recipeName,
      },
    },
  };
}

/** makeRecipeApprovalFn under gate "high": ALLOW passes; the rest is asked. */
function tierGateHigh(decision: "refuse" | "approve") {
  const asked: ApprovalRequestInput[] = [];
  const fn = vi.fn(async (input: ApprovalRequestInput) => {
    if (input.effective === "ALLOW") return true;
    asked.push(input);
    return decision === "approve"
      ? genuineGrant(input)
      : { approved: false as const, refusal: "rejected" as const };
  });
  return { fn, asked };
}

const fanOutStep = (extra: Record<string, unknown> = {}) => ({
  tool: "fan_out",
  items: ["a", "b"],
  as: "it",
  do: { tool: TOOL, name: "{{it}}" },
  into: "r",
  ...extra,
});

async function runFlat(
  steps: Array<Record<string, unknown>>,
  gate: ReturnType<typeof tierGateHigh>,
  extra: Partial<RunnerDeps> = {},
) {
  return runYamlRecipe(
    {
      name: "fanout-gate",
      trigger: { type: "manual" },
      steps,
    } as unknown as YamlRecipe,
    baseDeps(sandbox, {
      governance: compatHigh(),
      requireApprovalFn: gate.fn,
      ...extra,
    }),
  );
}

async function runChained(
  steps: Array<Record<string, unknown>>,
  gate: ReturnType<typeof tierGateHigh>,
) {
  const built = buildChainedDeps(
    baseDeps(sandbox, { governance: compatHigh(), requireApprovalFn: gate.fn }),
    undefined,
    "fanout-gate-chained",
  );
  return runChainedRecipe(
    { name: "fanout-gate-chained", steps } as unknown as ChainedRecipe,
    {
      env: {},
      maxConcurrency: 1,
      maxDepth: 3,
      dryRun: false,
      runLogDir: sandbox.dir,
    },
    built,
  );
}

describe("flat runner: a fan_out is gated as its child tool", () => {
  it("direct step: human asked, write refused (control)", async () => {
    const gate = tierGateHigh("refuse");
    await runFlat([{ tool: TOOL, name: "a", into: "r" }], gate);
    expect(gate.asked.map((a) => a.toolId)).toContain(TOOL);
    expect(target.dispatches).toBe(0);
  });

  it("wrapped in fan_out: human asked for the child tool, writes refused", async () => {
    const gate = tierGateHigh("refuse");
    await runFlat([fanOutStep()], gate);
    expect(target.dispatches, "no write without approval").toBe(0);
    expect(
      gate.asked.map((a) => a.toolId),
      "the high-tier child tool was put to a human",
    ).toContain(TOOL);
  });

  it("one approval covers the batch, names it, and still binds at dispatch", async () => {
    const gate = tierGateHigh("approve");
    const result = await runFlat([fanOutStep()], gate);
    expect(gate.asked).toHaveLength(1);
    expect(gate.asked[0]?.summary).toBe(`fan_out → tool ${TOOL} × 2`);
    // The grant was computed over the dispatched `fan_out` call; had the
    // identity been hashed over the child instead, dispatch would refuse.
    expect(result.errorMessage).toBeUndefined();
    expect(target.dispatches, "both approved items ran").toBe(2);
  });
});

describe("chained runner: a fan_out is gated as its child tool", () => {
  it("human asked for the child tool, writes refused", async () => {
    const gate = tierGateHigh("refuse");
    await runChained([{ id: "fan", ...fanOutStep() }], gate);
    expect(target.dispatches, "no write without approval").toBe(0);
    expect(gate.asked.map((a) => a.toolId)).toContain(TOOL);
  });

  it("approved batch dispatches — the identity is bound to the fan_out call", async () => {
    const gate = tierGateHigh("approve");
    await runChained([{ id: "fan", ...fanOutStep() }], gate);
    expect(gate.asked).toHaveLength(1);
    expect(gate.asked[0]?.proposedActionIdentity).toMatch(/^[0-9a-f]{64}$/);
    expect(target.dispatches, "both approved items ran").toBe(2);
  });
});

describe("governed profile: an unconfirmed file write in a fan_out asks", () => {
  it("file.write children are treated as irreversible, not rollback-backed", async () => {
    const asked: ApprovalRequestInput[] = [];
    const fn = vi.fn(async (input: ApprovalRequestInput) => {
      if (input.effective === "ALLOW") return true;
      asked.push(input);
      return { approved: false as const, refusal: "rejected" as const };
    });
    await runYamlRecipe(
      {
        name: "fanout-governed",
        trigger: { type: "manual" },
        steps: [
          {
            tool: "fan_out",
            items: ["one.txt", "two.txt"],
            as: "f",
            do: { tool: "file.write", path: "{{f}}", content: "x" },
            into: "r",
          },
        ],
      } as unknown as YamlRecipe,
      baseDeps(sandbox, { governance: governed(), requireApprovalFn: fn }),
    );
    expect(asked.map((a) => a.toolId)).toEqual(["file.write"]);
    expect(asked[0]?.reversibilityCeiling).toBe("irreversible");
  });
});

describe("patchwork.policy.yml is checked per child, before any child runs", () => {
  it("one forbidden item stops the whole batch; nothing is dispatched", async () => {
    setFlag(FLAG_ENFORCE_POLICY, true, false);
    writeFileSync(
      path.join(sandbox.dir, "patchwork.policy.yml"),
      'version: 1\ndefaults:\n  forbiddenPaths:\n    - "secrets/**"\n',
    );
    // Gate off for this case: the policy is the only thing that can stop it.
    const gate = tierGateHigh("approve");
    const result = await runFlat(
      [
        {
          tool: "fan_out",
          items: ["notes/ok.txt", "secrets/key.txt"],
          as: "p",
          do: { tool: TOOL, path: "{{p}}" },
          into: "r",
        },
      ],
      gate,
    );
    expect(target.dispatches, "the allowed item did not run either").toBe(0);
    expect(result.errorMessage ?? "").toContain("policy_denied");
  });

  it("control: with no forbidden item every child runs", async () => {
    setFlag(FLAG_ENFORCE_POLICY, true, false);
    writeFileSync(
      path.join(sandbox.dir, "patchwork.policy.yml"),
      'version: 1\ndefaults:\n  forbiddenPaths:\n    - "secrets/**"\n',
    );
    const gate = tierGateHigh("approve");
    await runFlat(
      [
        {
          tool: "fan_out",
          items: ["notes/a.txt", "notes/b.txt"],
          as: "p",
          do: { tool: TOOL, path: "{{p}}" },
          into: "r",
        },
      ],
      gate,
    );
    expect(target.dispatches).toBe(2);
  });
});
