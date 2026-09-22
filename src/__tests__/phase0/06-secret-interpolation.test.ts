/**
 * Phase 0 acceptance — scenario 6: a declared env secret, interpolated
 * everywhere a recipe can put it.
 *
 * The recipe declares `context: [{type: env, keys: [API_KEY]}]` and places
 * `{{API_KEY}}` into (a) a plain tool param, (b) a nested JSON string body,
 * (c) a URL query, (d) an http.post body and (e) an agent prompt. The fake
 * tools ECHO their params back as output, so an unredacted sink would carry
 * the secret in every persisted form.
 *
 * Invariant: the persisted run row, the in-memory step results and the
 * approval request payloads carry neither the secret nor its URL-encoded,
 * base64, base64url or JSON-escaped forms.
 *
 * Note on (e): the runner redacts declared env values from the AGENT prompt
 * (`redactSecretsForPrompt`) — the prompt as delivered to the driver does
 * NOT contain the secret even though the recipe interpolated it. That is
 * stricter than "only if the operator chose to", and is asserted as such.
 */

import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { runYamlRecipe, type YamlRecipe } from "../../recipes/yamlRunner.js";
import {
  baseDeps,
  capturingAgent,
  expectNoSecret,
  governed,
  makeSandbox,
  readRunLogText,
  readRunRows,
  recordingApproval,
  registerFakeTool,
  resetGovernanceState,
} from "./_harness.js";

const sandbox = makeSandbox("secret");
afterAll(() => sandbox.dispose());

/** 32 chars including characters that URL-encode and JSON-escape differently. */
function makeSecret(): string {
  return `${randomBytes(12).toString("hex")}+/=&"\\?#`.slice(0, 32);
}

function recipe(): YamlRecipe {
  return {
    name: "secret-everywhere",
    trigger: { type: "manual" },
    context: [{ type: "env", keys: ["API_KEY"] }],
    steps: [
      { tool: "sink.read", value: "{{API_KEY}}", into: "a" },
      { tool: "sink.read", body: '{"auth":{"key":"{{API_KEY}}"}}', into: "b" },
      {
        tool: "sink.read",
        url: "https://example.test/v1?key={{API_KEY}}&x=1",
        into: "c",
      },
      {
        tool: "http.post",
        url: "https://example.test/v1",
        body: '{"token":"{{API_KEY}}","payload":"x"}',
        into: "d",
      },
      {
        agent: {
          prompt: "Use this key to summarise: {{API_KEY}}",
          into: "e",
          driver: "claude-code",
        },
      },
    ],
  } as unknown as YamlRecipe;
}

describe("scenario 6 — a declared env secret never reaches a persisted sink", () => {
  let secret = "";
  beforeEach(() => {
    resetGovernanceState();
    secret = makeSecret();
    process.env.API_KEY = secret;
  });
  afterEach(() => {
    delete process.env.API_KEY;
    resetGovernanceState();
  });

  it("run row, step results, approval payloads and the agent prompt are clean; tool params still carry the raw value", async () => {
    const profile = governed();
    const seenParams: unknown[] = [];
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
    const agent = capturingAgent((p) => `echo: ${p}`);
    const approval = recordingApproval(() => true);
    const result = await runYamlRecipe(
      recipe(),
      baseDeps(sandbox, {
        governance: profile,
        requireApprovalFn: approval.fn,
        claudeCodeFn: agent.claudeCodeFn,
        claudeFn: agent.claudeFn,
      }),
    );
    expect(result.errorMessage).toBeUndefined();
    expect(result.stepResults.map((s) => s.status)).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
    ]);

    // The TOOLS legitimately received the raw secret (an http header needs it).
    expect((seenParams[0] as { value?: string }).value).toBe(secret);
    expect(String((seenParams[3] as { body?: string }).body)).toContain(secret);

    // …but no persisted or human-facing sink did.
    expectNoSecret(JSON.stringify(result.stepResults), secret, expect);
    expectNoSecret(JSON.stringify(approval.calls), secret, expect);
    const rows = readRunRows(sandbox.dir).filter(
      (r) => r.recipeName === "secret-everywhere",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.at(-1)?.stepResults?.length).toBe(5);
    expectNoSecret(readRunLogText(sandbox.dir), secret, expect);

    // The approval payload for the write DID describe the step (not blanked).
    const post = approval.calls.find((c) => c.toolId === "http.post");
    expect(post?.params?.url).toBe("https://example.test/v1");
    expect(String(post?.params?.body)).toContain("[REDACTED:env]");

    // The agent prompt: the runner redacts declared env values before the
    // model sees them, so the interpolation resolves to a marker.
    expect(agent.prompts).toHaveLength(1);
    expectNoSecret(agent.prompts[0] ?? "", secret, expect);
    // The captured step OUTPUT of the agent step is clean too.
    const e = result.stepResults.find((s) => s.id === "e");
    expectNoSecret(JSON.stringify(e), secret, expect);
  });
});
