/**
 * A target's HTTP failure must not be recorded as a successful business action,
 * and making it visible must not make Patchwork send the write again.
 *
 * `http.post` reports every HTTP response the same way: `{status, ok, body}`.
 * Both runners mark a tool step failed only when a tool returns
 * `{ok: false, error: <string>}` (yamlRunner and chainedRunner each implement
 * that convention separately). A refusal carries no top-level `error`, because
 * the target's own error travels inside `body` as a string. So a 422 that
 * created nothing was recorded as an `ok` step in a `done` run with no step
 * errors, beside the approval that allowed it. `tools/httpOutcome.ts` is the
 * one interpretation both runners and both replay paths now share.
 *
 * The dispatch guards are release-blocking, not decoration. Both runners retry
 * a failed step, so the obvious repair (give the refusal an `error` field)
 * turned one refused write into `retry + 1` writes. Mutation-checked:
 * classification went green and these guards went red at 3 dispatches.
 *
 * Real `http.post` against a real loopback server: a fake tool returns
 * whatever shape the test picks, so it cannot exhibit this defect.
 */

import { readFileSync } from "node:fs";
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
} from "vitest";
import {
  baseDeps,
  expectNoSecret,
  governed,
  makeSandbox,
  type PersistedRun,
  readRunRows,
  recordingApproval,
  registerFakeTool,
} from "../../__tests__/phase0/_harness.js";
import { _resetActiveProfileForTesting } from "../../governance/profile.js";
import {
  _resetSecretValuesForTesting,
  registerSecretValue,
} from "../../governance/secretValues.js";
import { foldOutcome } from "../../workers/shadowObserver.js";
import { type ChainedRecipe, runChainedRecipe } from "../chainedRunner.js";
import { categoriseHaltReason } from "../haltCategory.js";
import {
  buildChainedDeps,
  type RunnerDeps,
  runYamlRecipe,
  type YamlRecipe,
} from "../yamlRunner.js";
// Registers the REAL http.post and fan_out in the tool registry.
import "../tools/http.js";
import "../tools/fanOut.js";

const CLOSED = "/journals/closed-period"; // 422, creates nothing
const OPEN = "/journals/open-period"; // 201, creates a journal
const UNAUTHORISED = "/journals/unauthorised"; // 401, creates nothing
const FAILS_CLEAN = "/journals/fails-clean"; // 500, creates nothing
const FAILS_AFTER_WRITE = "/journals/fails-after-write"; // creates a journal, THEN 500
const ECHOES_SECRET = "/journals/echoes-secret"; // 422 whose body echoes a secret
const BIG_REFUSAL = "/journals/big-refusal"; // 422 with a body well over 8 KB
const REDIRECT_THEN_401 = "/journals/redirect-then-401"; // creates, 303s, then the GET gets 401
const REDIRECTED_TO = "/resource/1";

const SECRET = "tok-synthetic-9f3c2a7e5b1d4c68";

const JOURNAL_BODY = JSON.stringify({
  lines: [
    { account: "acct-0001", debit: 100 },
    { account: "acct-0002", credit: 100 },
  ],
});

/** A synthetic ledger API. `journals` is the independent record of truth. */
const target = {
  server: undefined as Server | undefined,
  url: "",
  dispatches: 0,
  journals: [] as Array<{ id: string }>,
};

function createJournal() {
  const journal = { id: `jr_${target.journals.length + 1}` };
  target.journals.push(journal);
  return journal;
}

beforeAll(async () => {
  target.server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      target.dispatches++;
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      switch (req.url) {
        case CLOSED:
          return json(422, {
            error: "PERIOD_CLOSED",
            message: "The accounting period is closed.",
          });
        case OPEN:
          return json(201, createJournal());
        case UNAUTHORISED:
          return json(401, { error: "UNAUTHORISED" });
        case FAILS_CLEAN:
          return json(500, { error: "INTERNAL" });
        case FAILS_AFTER_WRITE:
          createJournal();
          return json(500, { error: "INTERNAL" });
        case ECHOES_SECRET:
          return json(422, { error: "BAD_TOKEN", received: SECRET });
        case REDIRECT_THEN_401: {
          createJournal();
          res.writeHead(303, { location: `${target.url}${REDIRECTED_TO}` });
          res.end();
          return;
        }
        case REDIRECTED_TO:
          return json(401, { error: "UNAUTHORISED" });
        case BIG_REFUSAL:
          return json(422, { error: "PERIOD_CLOSED", page: "x".repeat(9000) });
        default:
          res.writeHead(404);
          res.end();
      }
    });
  });
  const server = target.server;
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  target.url = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  const server = target.server;
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

let sandbox: ReturnType<typeof makeSandbox>;

beforeEach(() => {
  target.dispatches = 0;
  target.journals = [];
  sandbox = makeSandbox("http-refusal");
});

afterEach(() => {
  _resetActiveProfileForTesting();
  _resetSecretValuesForTesting();
  sandbox.dispose();
});

function postStep(route: string, extra: Record<string, unknown> = {}) {
  return {
    tool: "http.post",
    url: `${target.url}${route}`,
    body: JOURNAL_BODY,
    // The target is loopback. `allowPrivate` is the tool's documented,
    // per-step way to reach one; the operator kill-flag is left at its
    // default.
    allowPrivate: true,
    ...extra,
  };
}

/** A fresh sandbox per test means exactly one persisted run row. */
function onlyRun(): PersistedRun {
  const rows = readRunRows(sandbox.dir);
  expect(rows, "exactly one run row persisted").toHaveLength(1);
  return rows[0] as PersistedRun;
}

function stepRow(run: PersistedRun, id: string) {
  const step = run.stepResults?.find((s) => s.id === id);
  expect(step, `step "${id}" was recorded`).toBeDefined();
  return step as Record<string, unknown>;
}

/** Everything a reader of the persisted row would take as "it worked". */
function recordedAsSuccess(run: PersistedRun, id: string): boolean {
  return (
    stepRow(run, id).status === "ok" &&
    run.status === "done" &&
    run.hadStepErrors !== true
  );
}

async function runFlat(
  steps: Array<Record<string, unknown>>,
  recipeExtra: Record<string, unknown> = {},
  depsExtra: Partial<RunnerDeps> = {},
) {
  const approval = recordingApproval(() => true);
  await runYamlRecipe(
    {
      name: "journal-post",
      trigger: { type: "manual" },
      steps,
      ...recipeExtra,
    } as unknown as YamlRecipe,
    baseDeps(sandbox, {
      governance: governed(),
      requireApprovalFn: approval.fn,
      ...depsExtra,
    }),
  );
  return { approval, run: onlyRun() };
}

async function runChained(
  steps: Array<Record<string, unknown>>,
  recipeExtra: Record<string, unknown> = {},
  mockedOutputs?: Map<string, unknown>,
  nested?: Record<string, unknown>,
) {
  const approval = recordingApproval(() => true);
  // Production wiring: buildChainedDeps forwards the approval fn.
  const built = buildChainedDeps(
    baseDeps(sandbox, {
      governance: governed(),
      requireApprovalFn: approval.fn,
    }),
    undefined,
    "journal-post-chained",
  );
  const deps = nested
    ? {
        ...built,
        loadNestedRecipe: async () => ({
          recipe: nested as unknown as ChainedRecipe,
        }),
      }
    : built;
  const result = await runChainedRecipe(
    {
      name: "journal-post-chained",
      steps,
      ...recipeExtra,
    } as unknown as ChainedRecipe,
    {
      env: {},
      maxConcurrency: 1,
      maxDepth: 3,
      dryRun: false,
      runLogDir: sandbox.dir,
      ...(mockedOutputs && { mockedOutputs }),
    },
    deps,
  );
  return { approval, result, run: onlyRun() };
}

describe("flat runner — a target refusal", () => {
  it("records a successful post as a successful action (control)", async () => {
    const { run } = await runFlat([{ ...postStep(OPEN), into: "posted" }]);

    expect(target.dispatches).toBe(1);
    expect(target.journals).toHaveLength(1);
    expect(stepRow(run, "posted").status).toBe("ok");
    expect(run.status).toBe("done");
  });

  it("does NOT record an unhandled 422 as a successful action", async () => {
    const { approval, run } = await runFlat([
      { ...postStep(CLOSED), into: "posted" },
    ]);

    // Setup held: approved, reached the target exactly once, nothing created.
    expect(approval.calls.map((c) => c.toolId)).toContain("http.post");
    expect(target.dispatches).toBe(1);
    expect(target.journals).toHaveLength(0);

    expect(recordedAsSuccess(run, "posted")).toBe(false);
    const step = stepRow(run, "posted");
    expect(step.status).toBe("error");
    expect(run.hadStepErrors).toBe(true);
    expect(categoriseHaltReason(step.haltReason as string)).toBe(
      "http_rejected",
    );
  });

  it("dispatches a refused write exactly once even when the step declares retries", async () => {
    const { run } = await runFlat([
      { ...postStep(CLOSED, { retry: 2, retryDelay: 1 }), into: "posted" },
    ]);

    expect(target.dispatches).toBe(1);
    expect(target.journals).toHaveLength(0);
    // The halt sentence must not claim attempts that were never made.
    expect(String(stepRow(run, "posted").haltReason)).not.toMatch(
      /after \d+ attempts/,
    );
  });

  it("keeps the target's answer as evidence on the failed step", async () => {
    const { run } = await runFlat([{ ...postStep(CLOSED), into: "posted" }]);

    const output = stepRow(run, "posted").output as Record<string, unknown>;
    expect(output.status).toBe(422);
    expect(String(output.body)).toContain("PERIOD_CLOSED");
  });

  it("redacts a known secret the target echoes back in a refusal", async () => {
    registerSecretValue(SECRET, "test");
    await runFlat([{ ...postStep(ECHOES_SECRET), into: "posted" }]);

    const text = readFileSync(path.join(sandbox.dir, "runs.jsonl"), "utf8");
    expect(text).toContain("BAD_TOKEN"); // the evidence is there…
    expectNoSecret(text, SECRET, expect); // …without the secret
  });

  it("files a 401 from an arbitrary endpoint as a rejection, not a connector auth failure", async () => {
    const { run } = await runFlat([
      { ...postStep(UNAUTHORISED), into: "posted" },
    ]);

    expect(
      categoriseHaltReason(stepRow(run, "posted").haltReason as string),
    ).toBe("http_rejected");
  });
});

describe("flat runner — a server error (500)", () => {
  it("before any write: failed, not retried, and no claim about what exists", async () => {
    const { run } = await runFlat([
      { ...postStep(FAILS_CLEAN, { retry: 2, retryDelay: 1 }), into: "posted" },
    ]);

    expect(target.dispatches).toBe(1);
    expect(target.journals).toHaveLength(0); // independent truth
    const step = stepRow(run, "posted");
    expect(step.status).toBe("error");
    expect(categoriseHaltReason(step.haltReason as string)).toBe(
      "http_unverified",
    );
    expect(String(step.haltReason)).toMatch(/has not been verified/);
    expect(String(step.haltReason)).not.toMatch(
      /no journal|nothing (was )?(created|changed|happened)/i,
    );
  });

  it("after the write was applied: identical record, and the journal really exists", async () => {
    const { run } = await runFlat([
      {
        ...postStep(FAILS_AFTER_WRITE, { retry: 2, retryDelay: 1 }),
        into: "posted",
      },
    ]);

    expect(target.dispatches).toBe(1); // no second write
    expect(target.journals).toHaveLength(1); // independent truth: it happened
    const step = stepRow(run, "posted");
    expect(step.status).toBe("error");
    expect(String(step.haltReason)).toMatch(/has not been verified/);
    expect(String(step.haltReason)).not.toMatch(
      /no journal|nothing (was )?(created|changed|happened)/i,
    );
  });
});

describe("flat runner — a tolerated refusal", () => {
  it("optional: true lets the run continue but records the step as failed", async () => {
    const { run } = await runFlat([
      { ...postStep(CLOSED), into: "posted", optional: true },
      { ...postStep(OPEN), into: "next" },
    ]);

    expect(target.dispatches).toBe(2);
    expect(target.journals).toHaveLength(1); // the later step still ran
    expect(stepRow(run, "posted").status).toBe("error");
    expect(stepRow(run, "next").status).toBe("ok");
    expect(run.status).toBe("done");
    expect(run.hadStepErrors).toBe(true); // not a clean summary
  });

  it("on_error.fallback: log_only does the same", async () => {
    const { run } = await runFlat(
      [
        { ...postStep(CLOSED), into: "posted" },
        { ...postStep(OPEN), into: "next" },
      ],
      { on_error: { fallback: "log_only" } },
    );

    expect(target.journals).toHaveLength(1);
    expect(stepRow(run, "posted").status).toBe("error");
    expect(stepRow(run, "next").status).toBe("ok");
    expect(run.hadStepErrors).toBe(true);
  });
});

describe("flat runner — replay", () => {
  it("classifies a legacy captured refusal (no new metadata) without sending anything", async () => {
    // Exactly what the flight recorder stored for a refusal before this fix.
    const legacy = JSON.stringify({
      status: 422,
      ok: false,
      body: '{"error":"PERIOD_CLOSED"}',
    });
    const { run } = await runFlat(
      [{ ...postStep(CLOSED), into: "posted" }],
      {},
      { mockedOutputs: new Map([["posted", legacy]]) },
    );

    expect(target.dispatches).toBe(0);
    expect(stepRow(run, "posted").status).toBe("error");
    expect(
      categoriseHaltReason(stepRow(run, "posted").haltReason as string),
    ).toBe("http_rejected");
  });
});

describe("chained runner — a target refusal", () => {
  it("records a successful post as a successful action (control)", async () => {
    const { result } = await runChained([{ id: "post", ...postStep(OPEN) }]);

    expect(target.dispatches).toBe(1);
    expect(target.journals).toHaveLength(1);
    expect(result.stepResults.get("post")?.success).toBe(true);
    expect(result.success).toBe(true);
  });

  it("does NOT record an unhandled 422 as a successful action", async () => {
    const { approval, result, run } = await runChained([
      { id: "post", ...postStep(CLOSED) },
    ]);

    expect(approval.calls.map((c) => c.toolId)).toContain("http.post");
    expect(target.dispatches).toBe(1);
    expect(target.journals).toHaveLength(0);

    expect(result.stepResults.get("post")?.success).toBe(false);
    expect(result.success).toBe(false);
    expect(recordedAsSuccess(run, "post")).toBe(false);
    expect(
      categoriseHaltReason(stepRow(run, "post").haltReason as string),
    ).toBe("http_rejected");
  });

  it("dispatches a refused write exactly once even when the step declares retries", async () => {
    await runChained([
      { id: "post", ...postStep(CLOSED, { retry: 2, retryDelay: 1 }) },
    ]);

    expect(target.dispatches).toBe(1);
    expect(target.journals).toHaveLength(0);
  });
});

describe("chained runner — a server error (500)", () => {
  it("before any write: failed, not retried", async () => {
    const { result, run } = await runChained([
      { id: "post", ...postStep(FAILS_CLEAN, { retry: 2, retryDelay: 1 }) },
    ]);

    expect(target.dispatches).toBe(1);
    expect(target.journals).toHaveLength(0);
    expect(result.stepResults.get("post")?.success).toBe(false);
    expect(
      categoriseHaltReason(stepRow(run, "post").haltReason as string),
    ).toBe("http_unverified");
  });

  it("after the write was applied: not retried, and the journal really exists", async () => {
    const { result, run } = await runChained([
      {
        id: "post",
        ...postStep(FAILS_AFTER_WRITE, { retry: 2, retryDelay: 1 }),
      },
    ]);

    expect(target.dispatches).toBe(1);
    expect(target.journals).toHaveLength(1);
    expect(result.stepResults.get("post")?.success).toBe(false);
    expect(String(stepRow(run, "post").haltReason)).toMatch(
      /has not been verified/,
    );
  });
});

describe("chained runner — a tolerated refusal", () => {
  it("optional: true lets the run continue but records the step as failed", async () => {
    const { result, run } = await runChained([
      { id: "post", ...postStep(CLOSED), optional: true },
      { id: "next", ...postStep(OPEN), awaits: ["post"] },
    ]);

    expect(target.journals).toHaveLength(1); // the later step still ran
    expect(result.stepResults.get("post")?.success).toBe(false);
    expect(result.stepResults.get("next")?.success).toBe(true);
    expect(result.success).toBe(true); // tolerated: the run finishes
    expect(stepRow(run, "post").status).toBe("error");
    expect(run.status).toBe("done");
    expect(run.hadStepErrors).toBe(true); // not a clean summary
  });

  it("on_error.fallback: log_only does the same", async () => {
    const { result, run } = await runChained(
      [
        { id: "post", ...postStep(CLOSED) },
        { id: "next", ...postStep(OPEN), awaits: ["post"] },
      ],
      { on_error: { fallback: "log_only" } },
    );

    expect(target.journals).toHaveLength(1);
    expect(result.stepResults.get("post")?.success).toBe(false);
    expect(stepRow(run, "post").status).toBe("error");
    expect(run.hadStepErrors).toBe(true);
  });
});

describe("chained runner — replay", () => {
  it("classifies a legacy captured refusal without sending anything", async () => {
    const legacy = {
      status: 422,
      ok: false,
      body: '{"error":"PERIOD_CLOSED"}',
    };
    const { result } = await runChained(
      [{ id: "post", ...postStep(CLOSED) }],
      {},
      new Map([["post", legacy]]),
    );

    expect(target.dispatches).toBe(0);
    expect(result.stepResults.get("post")?.success).toBe(false);
  });
});

describe("worker trust — responsibility for an HTTP failure is unassessed", () => {
  const opts = { now: Date.now(), windowMs: 24 * 60 * 60 * 1000 };

  it("a persisted http.post refusal is neither credited nor penalised", async () => {
    const { run } = await runFlat([{ ...postStep(CLOSED), into: "posted" }]);
    const step = stepRow(run, "posted");

    expect(
      foldOutcome(
        {
          tool: step.tool as string,
          status: step.status as "error",
          haltReason: step.haltReason as string,
        },
        Date.now(),
        opts,
      ),
    ).toEqual({ fold: false });
  });

  it("a persisted server error is withheld the same way", async () => {
    const { run } = await runFlat([
      { ...postStep(FAILS_AFTER_WRITE), into: "posted" },
    ]);
    const step = stepRow(run, "posted");

    expect(
      foldOutcome(
        {
          tool: step.tool as string,
          status: step.status as "error",
          haltReason: step.haltReason as string,
        },
        Date.now(),
        opts,
      ),
    ).toEqual({ fold: false });
  });

  it("an unrelated tool failure still counts against the worker", () => {
    expect(
      foldOutcome(
        {
          tool: "file.write",
          status: "error",
          haltReason:
            'Tool "file.write" in step "s" reported an error: disk full',
        },
        Date.now(),
        opts,
      ),
    ).toEqual({ fold: true, good: false });
  });
});

// ---------------------------------------------------------------------------
// Paths found by independent review. Each was reproduced before it was fixed.
// ---------------------------------------------------------------------------

describe("chained runner — a nested recipe", () => {
  it("does not resend the child's refused write when the PARENT step retries", async () => {
    const { result, run } = await runChained(
      [{ id: "sub", recipe: "child", retry: 2, retryDelay: 1 }],
      {},
      undefined,
      { name: "child", steps: [{ id: "post", ...postStep(FAILS_CLEAN) }] },
    );

    expect(target.dispatches).toBe(1);
    expect(result.stepResults.get("sub")?.success).toBe(false);
    expect(categoriseHaltReason(stepRow(run, "sub").haltReason as string)).toBe(
      "http_unverified",
    );
  });
});

describe("fan_out over http.post", () => {
  const fanOut = (route: string, extra: Record<string, unknown> = {}) => ({
    tool: "fan_out",
    items: ["a", "b"],
    do: postStep(route),
    into: "batch",
    ...extra,
  });

  it("records a refused iteration as failed, not ok (on_iter_error: continue)", async () => {
    const { run } = await runFlat([fanOut(CLOSED)]);

    expect(target.dispatches).toBe(2);
    const output = stepRow(run, "batch").output as Array<{
      ok: boolean;
      error?: string;
    }>;
    expect(output.map((r) => r.ok)).toEqual([false, false]);
    expect(String(output[0]?.error)).toMatch(/^http_rejected:/);
  });

  it("halts on a refused iteration and a step retry does not resend it (flat)", async () => {
    const { run } = await runFlat([
      fanOut(CLOSED, { on_iter_error: "halt", retry: 2, retryDelay: 1 }),
    ]);

    expect(target.dispatches).toBe(1);
    const step = stepRow(run, "batch");
    expect(step.status).toBe("error");
    expect(categoriseHaltReason(step.haltReason as string)).toBe(
      "http_rejected",
    );
  });

  it("halts on a refused iteration and a step retry does not resend it (chained)", async () => {
    const { result } = await runChained([
      {
        id: "batch",
        ...fanOut(CLOSED, { on_iter_error: "halt", retry: 2, retryDelay: 1 }),
      },
    ]);

    expect(target.dispatches).toBe(1);
    expect(result.stepResults.get("batch")?.success).toBe(false);
  });
});

describe("evidence that survives a large error page", () => {
  it("keeps the status of a >8 KB refusal, so replay can still classify it without sending", async () => {
    const live = await runFlat([{ ...postStep(BIG_REFUSAL), into: "posted" }]);
    const output = stepRow(live.run, "posted").output as Record<
      string,
      unknown
    >;
    expect(output["[truncated]"]).toBeUndefined(); // not a truncation envelope
    expect(output.status).toBe(422);
    expect(String(output.body)).toContain("PERIOD_CLOSED");

    // Replay from exactly what was persisted.
    sandbox.dispose();
    sandbox = makeSandbox("http-refusal-replay");
    target.dispatches = 0;
    const { run } = await runFlat(
      [{ ...postStep(BIG_REFUSAL), into: "posted" }],
      {},
      { mockedOutputs: new Map([["posted", JSON.stringify(output)]]) },
    );
    expect(target.dispatches).toBe(0);
    expect(stepRow(run, "posted").status).toBe("error");
  });
});

describe("a step id that contains another category's keyword", () => {
  it("is still filed and withheld as an HTTP failure (flat and chained)", async () => {
    const flat = await runFlat([
      { ...postStep(CLOSED), into: "alert_budget_exceeded" },
    ]);
    const flatStep = stepRow(flat.run, "alert_budget_exceeded");
    expect(categoriseHaltReason(flatStep.haltReason as string)).toBe(
      "http_rejected",
    );
    expect(
      foldOutcome(
        {
          tool: "http.post",
          status: "error",
          haltReason: flatStep.haltReason as string,
        },
        Date.now(),
        { windowMs: 1 },
      ),
    ).toEqual({ fold: false });

    sandbox.dispose();
    sandbox = makeSandbox("http-refusal-keyword");
    const chained = await runChained([
      { id: "step_timeout_notice", ...postStep(CLOSED) },
    ]);
    expect(
      categoriseHaltReason(
        stepRow(chained.run, "step_timeout_notice").haltReason as string,
      ),
    ).toBe("http_rejected");
  });
});

describe("chained runner — a tolerated refusal reads as failed everywhere", () => {
  it("counts it as failed in the summary a CLI footer prints", async () => {
    const { result } = await runChained([
      { id: "post", ...postStep(CLOSED), optional: true },
      { id: "next", ...postStep(OPEN), awaits: ["post"] },
    ]);

    expect(result.summary.failed).toBe(1);
    expect(result.summary.succeeded).toBe(1);
  });
});

describe("worker trust — rows with less to go on", () => {
  const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const opts = { now: Date.now(), windowMs: 24 * 60 * 60 * 1000 };

  it("withholds a CLI-written row that kept the error but no halt sentence", () => {
    expect(
      foldOutcome(
        {
          tool: "http.post",
          status: "error",
          error:
            "http_rejected: the target rejected the request (HTTP 422); not retried",
        },
        twoDaysAgo,
        opts,
      ),
    ).toEqual({ fold: false });
  });

  it("withholds a legacy row that recorded a refused http.post as ok", () => {
    expect(
      foldOutcome(
        {
          tool: "http.post",
          status: "ok",
          output: { status: 422, ok: false, body: "{}" },
        },
        twoDaysAgo,
        opts,
      ),
    ).toEqual({ fold: false });
  });

  it("still credits a legacy row whose captured status was a success", () => {
    expect(
      foldOutcome(
        {
          tool: "http.post",
          status: "ok",
          output: { status: 201, ok: true, body: "{}" },
        },
        twoDaysAgo,
        opts,
      ),
    ).toEqual({ fold: true, good: true });
  });
});

// ---------------------------------------------------------------------------
// Second review round. Each case was reproduced before it was fixed.
// ---------------------------------------------------------------------------

describe("a 4xx that arrives after a redirect", () => {
  it("is 'unverified', never 'rejected': the write before the redirect may have landed", async () => {
    const { run } = await runFlat([
      {
        ...postStep(REDIRECT_THEN_401, { retry: 2, retryDelay: 1 }),
        into: "posted",
      },
    ]);

    expect(target.journals).toHaveLength(1); // independent truth: it landed
    expect(target.dispatches).toBe(2); // the POST and the redirected GET, once
    const step = stepRow(run, "posted");
    expect(step.status).toBe("error");
    expect(categoriseHaltReason(step.haltReason as string)).toBe(
      "http_unverified",
    );
    expect(String(step.haltReason)).toMatch(/after a redirect/);
    expect(String(step.haltReason)).not.toMatch(/rejected/);
  });
});

describe("chained runner — a nested child with a tolerated HTTP failure", () => {
  it("names the failure that ended the child, and still never resends the tolerated write", async () => {
    const { result, run } = await runChained(
      [{ id: "sub", recipe: "child", retry: 2, retryDelay: 1 }],
      {},
      undefined,
      {
        name: "child",
        steps: [
          { id: "notify", ...postStep(FAILS_CLEAN), optional: true },
          {
            id: "sync",
            tool: "http.post",
            // Nothing listens on port 1: a transport failure, not an HTTP answer.
            url: "http://127.0.0.1:1/sync",
            body: "{}",
            allowPrivate: true,
            awaits: ["notify"],
          },
        ],
      },
    );

    // A retry of "sub" would re-send the tolerated POST, so it is not retried.
    expect(target.dispatches).toBe(1);
    expect(result.stepResults.get("sub")?.success).toBe(false);
    // …but the child did not end on that POST, so it is not blamed for it.
    const category = categoriseHaltReason(
      stepRow(run, "sub").haltReason as string,
    );
    expect(category).not.toBe("http_unverified");
    expect(category).not.toBe("http_rejected");
  });
});

describe("another tool that surfaces an http_* message verbatim", () => {
  it("is not treated as an HTTP failure: it is retried, categorised as its own, and counted", async () => {
    const relay = registerFakeTool({
      id: "fake.relay",
      isWrite: false,
      execute: async () => {
        throw new Error(
          "http_rejected: the target rejected the request (HTTP 422); not retried",
        );
      },
    });
    const { run } = await runFlat([
      { tool: "fake.relay", into: "relayed", retry: 2, retryDelay: 1 },
    ]);

    expect(relay).toHaveBeenCalledTimes(3);
    const step = stepRow(run, "relayed");
    expect(categoriseHaltReason(step.haltReason as string)).not.toBe(
      "http_rejected",
    );
    expect(
      foldOutcome(
        {
          tool: "fake.relay",
          status: "error",
          haltReason: step.haltReason as string,
          error: step.error as string,
        },
        Date.now(),
        { windowMs: 1 },
      ),
    ).toEqual({ fold: true, good: false });
  });
});

describe("fan_out evidence stays small", () => {
  it("compacts each failed iteration so the step's capture is not truncated away", async () => {
    const { run } = await runFlat([
      {
        tool: "fan_out",
        items: ["a", "b", "c"],
        do: postStep(BIG_REFUSAL),
        into: "batch",
      },
    ]);

    const output = stepRow(run, "batch").output as Array<{
      ok: boolean;
      output?: string;
    }>;
    expect(Array.isArray(output)).toBe(true); // not a truncation envelope
    for (const item of output) {
      expect(item.ok).toBe(false);
      expect(String(item.output).length).toBeLessThan(2000);
      expect(String(item.output)).toContain("422");
    }
  });
});
