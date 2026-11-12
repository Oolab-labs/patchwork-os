/**
 * Phase 0 acceptance — scenario 10: a recipe VARIABLE under a secret-like
 * name, next to a declared env value as the control.
 *
 * Scenario 6 covers a declared `type: env` block. A recipe can also be handed
 * a value as a variable — a declared default or a caller-supplied `--var` —
 * and both arrive in the runner the same way, as the seed context. When the
 * variable's NAME says it is a credential (`api_key`, `cli_token`), its value
 * is held to the same rule as an env value: the persisted run row, the step
 * results and the approval payloads record `[REDACTED:vars]`, never the value.
 *
 * An ordinary variable (`repo`) is NOT redacted — redacting every variable
 * would hollow out the run log — and is asserted as such, so this test fails
 * on over-redaction as well as on under-redaction.
 *
 * The tools still receive the raw value: an http header legitimately needs it.
 */

import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ChainedRecipe,
  ExecutionDeps,
} from "../../recipes/chainedRunner.js";
import { runChainedRecipe } from "../../recipes/chainedRunner.js";
import { runYamlRecipe, type YamlRecipe } from "../../recipes/yamlRunner.js";
import { RecipeRunLog } from "../../runLog.js";
import {
  baseDeps,
  expectNoSecret,
  governed,
  makeSandbox,
  readRunLogText,
  readRunRows,
  recordingApproval,
  registerFakeTool,
  resetGovernanceState,
} from "./_harness.js";

const sandbox = makeSandbox("sensitive-vars");
afterAll(() => sandbox.dispose());

/** 32 chars including characters that URL-encode and JSON-escape differently. */
function makeSecret(): string {
  return `${randomBytes(12).toString("hex")}+/=&"\\?#`.slice(0, 32);
}

const ORDINARY = "example-org/example-repo";

function flatRecipe(): YamlRecipe {
  return {
    name: "sensitive-vars-flat",
    trigger: { type: "manual" },
    allowWrites: ["http.post"],
    context: [{ type: "env", keys: ["CONTROL_KEY"] }],
    steps: [
      { tool: "sink.read", value: "{{api_key}}", into: "a" },
      { tool: "sink.read", value: "{{cli_token}}", into: "b" },
      { tool: "sink.read", value: "{{CONTROL_KEY}}", into: "c" },
      { tool: "sink.read", value: "{{repo}}", into: "d" },
      {
        tool: "http.post",
        url: "https://example.test/v1",
        body: '{"k":"{{api_key}}","t":"{{cli_token}}"}',
        into: "e",
      },
    ],
  } as unknown as YamlRecipe;
}

describe("scenario 10 — a variable named like a credential never reaches a persisted sink", () => {
  let declaredDefault = "";
  let cliValue = "";
  let envValue = "";
  beforeEach(() => {
    resetGovernanceState();
    declaredDefault = makeSecret();
    cliValue = makeSecret();
    envValue = makeSecret();
    process.env.CONTROL_KEY = envValue;
  });
  afterEach(() => {
    delete process.env.CONTROL_KEY;
    resetGovernanceState();
  });

  it("flat runner: run row, step results and approval payloads are clean; tools still get the raw value; an ordinary variable is kept", async () => {
    const profile = governed();
    const seenParams: Array<Record<string, unknown>> = [];
    const echo = async (c: { params: Record<string, unknown> }) => {
      seenParams.push(c.params);
      return JSON.stringify(c.params);
    };
    registerFakeTool({ id: "sink.read", isWrite: false, execute: echo });
    registerFakeTool({
      id: "http.post",
      isWrite: true,
      riskDefault: "medium",
      execute: echo,
    });
    const approval = recordingApproval(() => true);
    const result = await runYamlRecipe(
      flatRecipe(),
      baseDeps(sandbox, {
        governance: profile,
        requireApprovalFn: approval.fn,
      }),
      // What every caller hands the runner: declared defaults merged under
      // caller-supplied values.
      { api_key: declaredDefault, cli_token: cliValue, repo: ORDINARY },
    );
    expect(result.errorMessage).toBeUndefined();
    expect(result.stepResults.map((s) => s.status)).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
    ]);

    // The TOOLS received the raw values.
    expect(seenParams[0]?.value).toBe(declaredDefault);
    expect(seenParams[1]?.value).toBe(cliValue);
    expect(String(seenParams[4]?.body)).toContain(cliValue);

    const stepText = JSON.stringify(result.stepResults);
    const approvalText = JSON.stringify(approval.calls);
    const logText = readRunLogText(sandbox.dir);
    const rows = readRunRows(sandbox.dir).filter(
      (r) => r.recipeName === "sensitive-vars-flat",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.at(-1)?.stepResults?.length).toBe(5);

    for (const value of [declaredDefault, cliValue, envValue]) {
      expectNoSecret(stepText, value, expect);
      expectNoSecret(approvalText, value, expect);
      expectNoSecret(logText, value, expect);
    }
    expect(logText).toContain("[REDACTED:vars]");
    expect(logText).toContain("[REDACTED:env]");
    // Not over-redacted: the ordinary variable is recorded as written.
    expect(logText).toContain(ORDINARY);
  });

  it("chained runner: a variable named like a credential is not recorded", async () => {
    governed();
    const seen: Array<Record<string, unknown>> = [];
    const deps: ExecutionDeps = {
      executeTool: async (_tool: string, params: Record<string, unknown>) => {
        seen.push(params);
        return JSON.stringify(params);
      },
      executeAgent: async () => "agent",
      loadNestedRecipe: async () => null,
    } as unknown as ExecutionDeps;
    const recipe = {
      name: "sensitive-vars-chained",
      trigger: { type: "chained" },
      steps: [
        { id: "s1", tool: "sink.read", value: "{{env.api_key}}" },
        { id: "s2", tool: "sink.read", value: "{{env.repo}}" },
      ],
    } as unknown as ChainedRecipe;
    registerFakeTool({
      id: "sink.read",
      isWrite: false,
      execute: async () => "",
    });
    const res = await runChainedRecipe(
      recipe,
      {
        env: { api_key: declaredDefault, repo: ORDINARY },
        maxConcurrency: 1,
        maxDepth: 3,
        dryRun: false,
        runLog: new RecipeRunLog({ dir: sandbox.dir }),
      },
      deps,
    );
    expect(res.success).toBe(true);
    expect(seen[0]?.value).toBe(declaredDefault);

    const rows = readRunRows(sandbox.dir).filter(
      (r) => r.recipeName === "sensitive-vars-chained",
    );
    expect(rows.length).toBeGreaterThan(0);
    const text = JSON.stringify(rows);
    expectNoSecret(text, declaredDefault, expect);
    expectNoSecret(JSON.stringify(res), declaredDefault, expect);
    expect(text).toContain("[REDACTED:vars]");
    expect(text).toContain(ORDINARY);
  });
});
