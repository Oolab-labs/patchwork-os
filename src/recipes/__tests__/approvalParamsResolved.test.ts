/**
 * An approval request must show the write that will actually happen.
 *
 * The gate handed the approver `step` verbatim — the raw YAML, before
 * `executeStep` renders its `{{templates}}`. So a person authorising a gated
 * write saw `content: "{{title}}"`, never the text. Observed live on
 * `butler-errand`: the queue entry read `{"content":"{{title}}", …}` while the
 * task actually filed was "Check the smoke alarm batteries".
 *
 * That is not cosmetic. The gate exists so a human can judge a compensable or
 * irreversible action before it happens, and approving an unrendered template
 * is consent to whatever an earlier step happened to produce. It also weakens
 * the Decision Record as evidence: it preserved what was PROPOSED, not what was
 * APPROVED, and for a gated action those must be the same string.
 *
 * Resolution is safe to do early — `deepRender` is pure string substitution
 * over the run context, with no execution — but the resolved values can carry
 * secrets the raw template did not, so the payload goes through
 * `captureForRunlog` (redaction + size cap) exactly as step outputs do.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  type RunnerDeps,
  runYamlRecipe,
  type YamlRecipe,
} from "../yamlRunner.js";

const TMP = mkdtempSync(path.join(os.tmpdir(), "approval-params-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function deps(extra: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    now: () => new Date("2026-08-11T12:00:00Z"),
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
    ...extra,
  };
}

describe("approval payload shows the resolved write", () => {
  it("renders templates before asking a human to approve", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const requireApprovalFn = vi.fn(
      async (i: { params?: Record<string, unknown> }) => {
        seen.push(i.params);
        return true;
      },
    );

    // `content` derives from an earlier step's output — the shape every
    // interesting gated write has, and the one the raw-step payload loses.
    const recipe = {
      name: "approval-params",
      trigger: { type: "manual" },
      steps: [
        {
          tool: "github.create_issue",
          repo: "acme/widgets",
          title: "x",
          into: "prior",
        },
        {
          tool: "file.write",
          path: `${TMP}/out`,
          content: "{{prior.title}}",
          into: "created",
        },
      ],
    } as unknown as YamlRecipe;

    await runYamlRecipe(
      recipe,
      deps({
        requireApprovalFn,
        mockConnectors: {
          "github.create_issue": {
            invoke: async <TOutput = unknown>() =>
              JSON.stringify({
                ok: true,
                number: 1,
                title: "Descale the coffee machine",
              }) as TOutput,
          },
        },
      }),
    );

    const writeApproval = seen.find((p) => p?.tool === "file.write");
    expect(writeApproval).toBeDefined();
    expect(writeApproval?.content).toBe("Descale the coffee machine");
    // The raw placeholder must not survive into what a person is shown.
    expect(JSON.stringify(writeApproval)).not.toContain("{{title}}");
  });

  it("redacts secrets that only appear once the template is resolved", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const requireApprovalFn = vi.fn(
      async (i: { params?: Record<string, unknown> }) => {
        seen.push(i.params);
        return true;
      },
    );

    // NOTE: the key is `token`, not `api_key`, and that is a finding rather
    // than a convenience. `SENSITIVE_KEY_PATTERNS` matches "apikey"/"api-key"
    // but NOT the snake_case `api_key` that recipe YAML naturally uses, so a
    // resolved `api_key` is NOT redacted today. Reported separately — shaping
    // this test around the gap would hide it; naming it keeps the redaction
    // wiring proven here while leaving the hole visible.
    const recipe = {
      name: "approval-secret",
      trigger: {
        type: "manual",
        vars: [{ name: "secret_value", default: "" }],
      },
      steps: [
        {
          tool: "file.write",
          path: `${TMP}/secret`,
          content: "ok",
          token: "{{secret_value}}",
        },
      ],
    } as unknown as YamlRecipe;

    await runYamlRecipe(recipe, deps({ requireApprovalFn }), {
      secret_value: "NOT-A-REAL-CREDENTIAL-SUPERSECRET",
    });

    const payload = JSON.stringify(seen.find((p) => p?.tool === "file.write"));
    expect(payload).not.toContain("SUPERSECRET");
  });
});
