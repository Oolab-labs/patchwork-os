/**
 * An agent step whose AI provider is not signed in is an AUTHENTICATION halt,
 * not an agent malfunction.
 *
 * When the provider CLI has no login, the orchestrator marks the task `error`
 * and keeps the CLI's own text in `output` ("Not logged in · Please run
 * /login" — the string `agentTextFromTask` documents, and the reason that
 * function decides on STATUS). The runner turned it into the halt sentence
 * `Agent step "x" returned no usable output: [agent step failed: …]`, which
 * categorised as `agent_silent_fail` with the hint "inspect prompt + check
 * trace" — advice that cannot help: the prompt is fine and the trace shows
 * one refused call. The remedy is to sign in to the provider.
 *
 * The markers below are built by the REAL emitters where the repo has one
 * (`agentTextFromTask` for the orchestrated path, the `${driver} exited N —
 * <detail>` shape of the direct driver path) rather than typed by hand.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { agentTextFromTask } from "../../recipeOrchestration.js";
import {
  categoriseHaltReason,
  deriveHaltReasonFromError,
  HALT_CATEGORY_HINTS,
} from "../haltCategory.js";
import {
  type RunnerDeps,
  runYamlRecipe,
  type YamlRecipe,
} from "../yamlRunner.js";

const TMP = mkdtempSync(path.join(os.tmpdir(), "agent-auth-halt-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function runWithAgentResult(result: string) {
  const recipe = {
    name: "auth-probe",
    trigger: { type: "manual" },
    steps: [{ agent: { prompt: "do it", driver: "local" }, into: "answer" }],
  } as unknown as YamlRecipe;
  const deps: RunnerDeps = {
    now: () => new Date("2026-10-12T09:00:00Z"),
    logDir: TMP,
    testMode: true,
    readFile: () => {
      throw new Error("nf");
    },
    writeFile: () => {},
    appendFile: () => {},
    mkdir: () => {},
    gitLogSince: () => "",
    gitStaleBranches: () => "",
    getDiagnostics: () => "",
    localFn: async () => result,
  } as unknown as RunnerDeps;
  return runYamlRecipe(recipe, deps);
}

/** Orchestrated path: the CLI exits 1 and prints its login error. */
const orchestratedNotLoggedIn = agentTextFromTask({
  status: "error",
  errorMessage: "Process exited with code 1",
  output: "Not logged in · Please run /login",
});

const NOT_SIGNED_IN_MARKERS: Array<[string, string]> = [
  ["orchestrated CLI, not logged in", orchestratedNotLoggedIn],
  [
    "direct driver, not logged in",
    "[agent step failed: claude exited 1 — Not logged in · Please run /login]",
  ],
  [
    "direct driver, invalid API key",
    "[agent step failed: claude exited 1 — Invalid API key · Please run /login]",
  ],
  [
    "API driver, authentication error",
    '[agent step failed: claude-api — 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}]',
  ],
  [
    "expired OAuth token",
    "[agent step failed: claude exited 1 — OAuth token has expired. Please obtain a new token or refresh your existing token.]",
  ],
];

describe("an AI provider that is not signed in", () => {
  it("the orchestrated marker really carries the CLI's login text", () => {
    expect(orchestratedNotLoggedIn).toContain("Not logged in");
  });

  for (const [label, marker] of NOT_SIGNED_IN_MARKERS) {
    it(`halts as agent_auth, not agent_silent_fail (${label})`, async () => {
      const result = await runWithAgentResult(marker);
      const halt = result.stepResults.find((s) => s.status === "error");
      expect(halt?.haltCategory).toBe("agent_auth");
      // Re-deriving from the stored sentence must agree with the stored tag.
      expect(categoriseHaltReason(halt?.haltReason)).toBe("agent_auth");
    });
  }

  it("the chained runner's sentence for the same failure categorises the same way", () => {
    const sentence = deriveHaltReasonFromError({
      stepId: "summarise",
      isAgent: true,
      status: "error",
      error: orchestratedNotLoggedIn,
    });
    expect(categoriseHaltReason(sentence)).toBe("agent_auth");
  });

  it("the chained runner's silent-fail error keeps the login text in its sentence", () => {
    // chainedRunner.ts wraps a detected marker as
    // `silent-fail detected (<pattern>): <marker>` before deriving the halt.
    const sentence = deriveHaltReasonFromError({
      stepId: "summarise",
      isAgent: true,
      status: "error",
      error: `silent-fail detected (agent step skipped or failed (string placeholder)): ${orchestratedNotLoggedIn}`,
    });
    expect(sentence).toContain("Not logged in");
    expect(categoriseHaltReason(sentence)).toBe("agent_auth");
  });

  it("its hint tells the operator to sign in to the AI provider", () => {
    const hint = HALT_CATEGORY_HINTS.agent_auth;
    expect(hint).toMatch(/sign in/i);
    expect(hint).toMatch(/AI provider/i);
    expect(hint).not.toMatch(/inspect prompt/i);
  });
});

describe("what must NOT move", () => {
  it("a genuine silent failure stays agent_silent_fail", async () => {
    const result = await runWithAgentResult(
      "[agent step failed: something nobody has a pattern for]",
    );
    const halt = result.stepResults.find((s) => s.status === "error");
    expect(halt?.haltCategory).toBe("agent_silent_fail");
  });

  it("a connector 401 inside a TOOL envelope stays auth_failure", () => {
    expect(
      categoriseHaltReason(
        'Tool "github.createIssue" in step "open" threw: 401 Unauthorized',
      ),
    ).toBe("auth_failure");
  });
});
