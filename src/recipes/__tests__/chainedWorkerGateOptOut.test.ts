/**
 * The same external write, same worker gate, two runners.
 *
 * `recipeCannotDisableWorkerGate.test.ts` proves `executeChainedStep` honours
 * `gateAutomatedRuns` — by handing it the flag directly. Production hands the
 * chained runner its deps through `buildChainedDeps`, which forwards
 * `requireApprovalFn` and NOT `gateAutomatedRuns` (yamlRunner.ts, the return
 * block of buildChainedDeps). `effectivePolicy.ts` then sees
 * workerGateInjected=false and honours `requireApproval: false` — so a
 * worker-owned CHAINED recipe opts itself out of the worker gate with one
 * boolean, which the flat runner refuses.
 *
 * Real `http.post` against a loopback server; the server's request count is
 * the independent record of whether the write happened.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
import { baseDeps, makeSandbox } from "../../__tests__/phase0/_harness.js";
import { _resetActiveProfileForTesting } from "../../governance/profile.js";
import { type ChainedRecipe, runChainedRecipe } from "../chainedRunner.js";
import {
  buildChainedDeps,
  runYamlRecipe,
  type YamlRecipe,
} from "../yamlRunner.js";
import "../tools/http.js";

const target = {
  server: undefined as Server | undefined,
  url: "",
  dispatches: 0,
};
let sandbox: ReturnType<typeof makeSandbox>;

beforeAll(async () => {
  target.server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      target.dispatches++;
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "rec_1" }));
    });
  });
  await new Promise<void>((r) => target.server!.listen(0, "127.0.0.1", r));
  target.url = `http://127.0.0.1:${(target.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => target.server?.close(() => r()));
});
beforeEach(() => {
  _resetActiveProfileForTesting();
  target.dispatches = 0;
  sandbox = makeSandbox("chained-worker-gate");
});
afterEach(() => {
  sandbox.dispose();
});

/** A worker gate that queues everything and is refused: if consulted, nothing runs. */
function refusingWorkerGate() {
  return vi.fn(async () => ({
    approved: false as const,
    refusal: "rejected" as const,
  }));
}
const step = {
  id: "post",
  tool: "http.post",
  url: "",
  body: "{}",
  allowPrivate: true,
};

describe("requireApproval:false cannot opt out of the worker gate", () => {
  it("flat runner: gate consulted, write refused (control)", async () => {
    const gate = refusingWorkerGate();
    await runYamlRecipe(
      {
        name: "opted-out",
        trigger: { type: "manual" },
        requireApproval: false,
        steps: [{ ...step, url: `${target.url}/records` }],
      } as unknown as YamlRecipe,
      baseDeps(sandbox, { requireApprovalFn: gate, gateAutomatedRuns: true }),
    );
    expect(gate).toHaveBeenCalled();
    expect(target.dispatches).toBe(0);
  });

  it("buildChainedDeps forwards the worker-gate signal", () => {
    const built = buildChainedDeps(
      baseDeps(sandbox, {
        requireApprovalFn: refusingWorkerGate(),
        gateAutomatedRuns: true,
      }),
      undefined,
      "opted-out-chained",
    );
    expect(built.gateAutomatedRuns).toBe(true);
  });

  it("chained runner via production wiring: gate consulted, write refused", async () => {
    const gate = refusingWorkerGate();
    const built = buildChainedDeps(
      baseDeps(sandbox, { requireApprovalFn: gate, gateAutomatedRuns: true }),
      undefined,
      "opted-out-chained",
    );
    await runChainedRecipe(
      {
        name: "opted-out-chained",
        requireApproval: false,
        steps: [{ ...step, url: `${target.url}/records` }],
      } as unknown as ChainedRecipe,
      {
        env: {},
        maxConcurrency: 1,
        maxDepth: 3,
        dryRun: false,
        runLogDir: sandbox.dir,
      },
      built,
    );
    expect(target.dispatches, "write refused on the chained path").toBe(0);
    expect(
      gate,
      "worker gate consulted on the chained path",
    ).toHaveBeenCalled();
  });
});
