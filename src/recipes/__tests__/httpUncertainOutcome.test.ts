/**
 * An `http.post` whose TARGET ACCEPTED the write but whose response never
 * reached Patchwork. Three shapes, all against a real loopback server that
 * counts every request it fully read:
 *   LOST      — body read in full, then the socket is destroyed (no response)
 *   MID_BODY  — 200 headers + partial body sent, then the socket is destroyed
 *   HANG      — body read in full, then nothing, past the tool's timeoutMs
 *
 * Invariant: once a write MAY have reached its destination, uncertainty must
 * not authorise another attempt. So with `retry: 2` the server must see
 * exactly ONE request, on every runner (flat, chained, fan_out, a nested
 * recipe whose PARENT step retries), the step must still FAIL, the halt must
 * read as delivered-but-unverified (not "check connectivity"), and the trust
 * fold must WITHHOLD (neither credit nor penalty).
 *
 * The decisive assertion is the SERVER's received count, never a local
 * attempts counter — a counter inside the tool would pass against a runner
 * that re-issued the request through a different code path.
 *
 * Positive controls pin the other side of the line: an ordinary write goes
 * out once; a connection REFUSED (nothing reached any target) still retries
 * as before; the existing `step_timeout` non-retry is unchanged.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
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
  governed,
  makeSandbox,
  type PersistedRun,
  readRunRows,
  recordingApproval,
} from "../../__tests__/phase0/_harness.js";
import { _resetActiveProfileForTesting } from "../../governance/profile.js";
import { foldOutcome } from "../../workers/shadowObserver.js";
import { type ChainedRecipe, runChainedRecipe } from "../chainedRunner.js";
import { categoriseHaltReason } from "../haltCategory.js";
import {
  buildChainedDeps,
  runYamlRecipe,
  type YamlRecipe,
} from "../yamlRunner.js";
import "../tools/http.js";
import "../tools/fanOut.js";

const OK = "/journals/ok";
const LOST = "/journals/lost-response";
const MID_BODY = "/journals/mid-body";
const HANG = "/journals/hang";
const TOOL_TIMEOUT_MS = 300;

const target = {
  server: undefined as Server | undefined,
  url: "",
  received: 0, // requests whose body the server read to the end
  sockets: new Set<Socket>(),
};

/** A port nothing listens on: the server is started then closed. */
let refusedUrl = "";

beforeAll(async () => {
  target.server = createServer((req, res) => {
    target.sockets.add(req.socket);
    req.resume();
    req.on("end", () => {
      target.received++; // the target ACCEPTED the write
      switch (req.url) {
        case OK:
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"id":"jr_1"}');
          return;
        case LOST:
          req.socket.destroy();
          return;
        case MID_BODY:
          res.writeHead(200, { "content-type": "application/json" });
          res.write('{"id":"jr_');
          setTimeout(() => req.socket.destroy(), 20);
          return;
        case HANG:
          return; // never answers
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

  const gone = createServer();
  await new Promise<void>((resolve) =>
    gone.listen(0, "127.0.0.1", () => resolve()),
  );
  const gonePort = (gone.address() as AddressInfo).port;
  await new Promise<void>((resolve) => gone.close(() => resolve()));
  refusedUrl = `http://127.0.0.1:${gonePort}/journals/refused`;
});

afterAll(async () => {
  for (const s of target.sockets) s.destroy();
  const server = target.server;
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

let sandbox: ReturnType<typeof makeSandbox>;
beforeEach(() => {
  target.received = 0;
  sandbox = makeSandbox("http-uncertain-outcome");
});
afterEach(() => {
  _resetActiveProfileForTesting();
  sandbox.dispose();
});

function postStep(route: string, extra: Record<string, unknown> = {}) {
  return {
    tool: "http.post",
    url: route.startsWith("http") ? route : `${target.url}${route}`,
    body: JSON.stringify({ lines: [{ account: "acct-0001", debit: 1 }] }),
    allowPrivate: true,
    timeoutMs: TOOL_TIMEOUT_MS,
    retry: 2,
    retryDelay: 1,
    ...extra,
  };
}

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

async function runFlat(steps: Array<Record<string, unknown>>) {
  const approval = recordingApproval(() => true);
  const result = await runYamlRecipe(
    {
      name: "journal-post",
      trigger: { type: "manual" },
      steps,
    } as unknown as YamlRecipe,
    baseDeps(sandbox, {
      governance: governed(),
      requireApprovalFn: approval.fn,
    }),
  );
  return { approval, result, run: onlyRun() };
}

async function runChained(
  steps: Array<Record<string, unknown>>,
  nested?: ChainedRecipe,
) {
  const approval = recordingApproval(() => true);
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
          recipe: nested,
          sourcePath: `${sandbox.dir}/child.yaml`,
        }),
      }
    : built;
  const result = await runChainedRecipe(
    { name: "journal-post-chained", steps } as unknown as ChainedRecipe,
    {
      env: {},
      maxConcurrency: 1,
      maxDepth: 3,
      dryRun: false,
      runLogDir: sandbox.dir,
      sourcePath: `${sandbox.dir}/parent.yaml`,
    },
    deps,
  );
  return { approval, result, run: onlyRun() };
}

const foldOpts = { now: Date.now(), windowMs: 24 * 60 * 60 * 1000 };

function foldOf(step: Record<string, unknown>) {
  return foldOutcome(
    {
      tool: step.tool as string,
      status: step.status as "ok" | "error",
      error: step.error as string | undefined,
      errorCode: step.errorCode as string | undefined,
      haltReason: step.haltReason as string | undefined,
      output: step.output as Record<string, unknown> | undefined,
    },
    Date.now(),
    foldOpts,
  );
}

const scenarios: Array<[string, string]> = [
  ["response lost after the body was read", LOST],
  ["headers sent, socket destroyed mid-body", MID_BODY],
  ["target hangs past the tool timeout", HANG],
];

for (const [label, route] of scenarios) {
  describe(`flat runner — ${label}`, () => {
    it("is sent exactly once despite retry: 2, and is NOT a success", async () => {
      const { run } = await runFlat([{ ...postStep(route), into: "posted" }]);
      expect(target.received, "requests the target read in full").toBe(1);
      const step = stepRow(run, "posted");
      expect(step.status).toBe("error");
      expect(run.status).not.toBe("done");
      expect(run.hadStepErrors).toBe(true);
      // step record, run status and halt reason agree
      expect(String(run.errorMessage ?? "")).toContain(
        String(step.error ?? "\u0000"),
      );
      // The halt sentence reports the attempts actually made, not the
      // configured count.
      expect(step.haltReason).toContain("after 1 attempt:");
    });

    it("is filed as delivered-but-unverified, carries the transport cause, and is withheld from trust", async () => {
      const { run } = await runFlat([{ ...postStep(route), into: "posted" }]);
      const step = stepRow(run, "posted");
      expect(step.errorCode).toBe("outcome_uncertain");
      expect(step.haltCategory).toBe("delivery_unverified");
      expect(categoriseHaltReason(step.haltReason as string)).toBe(
        "delivery_unverified",
      );
      // Question (a): the failure keeps its transport diagnostics.
      expect(String(step.error)).toMatch(
        /terminated|fetch failed|aborted|UND_ERR/i,
      );
      // Question (b): uncertainty stays uncertainty.
      expect(String(step.haltReason)).toContain("may have been applied");
      expect(foldOf(step)).toEqual({ fold: false });
    });
  });

  describe(`chained runner — ${label}`, () => {
    it("is sent exactly once despite retry: 2, and is NOT a success", async () => {
      const { result, run } = await runChained([
        { id: "post", ...postStep(route) },
      ]);
      expect(target.received, "requests the target read in full").toBe(1);
      expect(result.stepResults.get("post")?.success).toBe(false);
      expect(result.success).toBe(false);
      const step = stepRow(run, "post");
      expect(step.status).toBe("error");
      expect(run.status).not.toBe("done");
      expect(categoriseHaltReason(step.haltReason as string)).toBe(
        "delivery_unverified",
      );
      expect(foldOf(step)).toEqual({ fold: false });
    });
  });

  describe(`fan_out over http.post — ${label}`, () => {
    const fanOut = () => ({
      tool: "fan_out",
      items: ["a", "b"],
      do: postStep(route, { retry: undefined, retryDelay: undefined }),
      on_iter_error: "halt",
      retry: 2,
      retryDelay: 1,
      into: "batch",
    });

    it("halts after one dispatch and the step retry does not resend it (flat)", async () => {
      const { run } = await runFlat([fanOut()]);
      expect(target.received).toBe(1);
      const step = stepRow(run, "batch");
      expect(step.status).toBe("error");
      expect(step.haltCategory).toBe("delivery_unverified");
      expect(foldOf(step)).toEqual({ fold: false });
    });

    it("halts after one dispatch and the step retry does not resend it (chained)", async () => {
      const { result } = await runChained([{ id: "batch", ...fanOut() }]);
      expect(target.received).toBe(1);
      expect(result.stepResults.get("batch")?.success).toBe(false);
    });
  });

  describe(`nested recipe with a parent retry — ${label}`, () => {
    it("the parent's retry does not re-run the child's write", async () => {
      const child: ChainedRecipe = {
        name: "child-journal",
        steps: [
          {
            id: "post",
            ...postStep(route, { retry: undefined, retryDelay: undefined }),
          },
        ],
      } as unknown as ChainedRecipe;
      const { result, run } = await runChained(
        [{ id: "sub", recipe: "child.yaml", retry: 2, retryDelay: 1 }],
        child,
      );
      expect(target.received, "requests the target read in full").toBe(1);
      expect(result.stepResults.get("sub")?.success).toBe(false);
      const step = stepRow(run, "sub");
      expect(step.status).toBe("error");
      expect(categoriseHaltReason(step.haltReason as string)).toBe(
        "delivery_unverified",
      );
    });
  });
}

describe("positive controls — the line is drawn at the sent boundary", () => {
  it("an ordinary successful write goes out exactly once (flat + chained)", async () => {
    const { run } = await runFlat([{ ...postStep(OK), into: "posted" }]);
    expect(target.received).toBe(1);
    expect(stepRow(run, "posted").status).toBe("ok");
    expect(run.status).toBe("done");

    target.received = 0;
    sandbox.dispose();
    sandbox = makeSandbox("http-uncertain-outcome");
    const { result } = await runChained([{ id: "post", ...postStep(OK) }]);
    expect(target.received).toBe(1);
    expect(result.success).toBe(true);
  });

  it("a connection REFUSED still retries: nothing reached any target (flat)", async () => {
    const { run } = await runFlat([
      { ...postStep(refusedUrl), into: "posted" },
    ]);
    const step = stepRow(run, "posted");
    expect(step.status).toBe("error");
    expect(step.errorCode).toBeUndefined();
    expect(step.haltCategory).toBe("tool_threw");
    expect(categoriseHaltReason(step.haltReason as string)).not.toBe(
      "delivery_unverified",
    );
    // All three attempts were made — observed via the runner's own count.
    expect(step.haltReason).toContain("after 3 attempts:");
    expect(foldOf(step)).toEqual({ fold: true, good: false });
  });

  it("a connection REFUSED still retries (chained)", async () => {
    let calls = 0;
    const approval = recordingApproval(() => true);
    const built = buildChainedDeps(
      baseDeps(sandbox, {
        governance: governed(),
        requireApprovalFn: approval.fn,
      }),
      undefined,
      "journal-post-chained",
    );
    const executeTool: typeof built.executeTool = (...args) => {
      calls++;
      return built.executeTool(...args);
    };
    const result = await runChainedRecipe(
      {
        name: "journal-post-chained",
        steps: [{ id: "post", ...postStep(refusedUrl) }],
      } as unknown as ChainedRecipe,
      {
        env: {},
        maxConcurrency: 1,
        maxDepth: 3,
        dryRun: false,
        runLogDir: sandbox.dir,
      },
      { ...built, executeTool },
    );
    expect(result.success).toBe(false);
    expect(calls, "attempts observed at the tool boundary").toBe(3);
    expect(result.stepResults.get("post")?.error?.message).not.toContain(
      "outcome_uncertain",
    );
  });

  it("a lost response inside fan_out with on_iter_error: continue keeps going and does not resend that item", async () => {
    // The uncertainty is per-item: item 0 is lost, item 1 succeeds. The
    // aggregate records both; the step-level retry is not consulted because
    // the tool did not throw.
    const { run } = await runFlat([
      {
        tool: "fan_out",
        items: [LOST, OK],
        do: postStep("{{item}}", { retry: undefined, retryDelay: undefined }),
        on_iter_error: "continue",
        retry: 2,
        retryDelay: 1,
        into: "batch",
      },
    ]);
    expect(target.received).toBe(2);
    expect(stepRow(run, "batch").status).toBe("ok");
  });
});
