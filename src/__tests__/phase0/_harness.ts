/**
 * Phase 0 adversarial acceptance suite — shared harness.
 *
 * Every scenario runs the REAL flat runner (`runYamlRecipe`) with:
 *   - `governance: GOVERNED_PROFILE` on the deps AND `setActiveProfile` —
 *     the runner's per-step consult reads the deps, while `executeAgent`
 *     (containment) and `loadRecipeServers` (plugin policy) read the
 *     process-wide active profile. The bridge sets both; so does this.
 *   - a recording approval double,
 *   - `claudeCodeFn` / `claudeFn` doubles that capture the prompt,
 *   - fake tools registered through the real registry,
 *   - a temp `PATCHWORK_HOME` + `logDir`, `testMode: false`, so the run row
 *     is persisted to `runs.jsonl` and can be read back.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { KILL_SWITCH_WRITES, setFlag } from "../../featureFlags.js";
import { _setKillSwitchReaderForTesting } from "../../governance/killSwitchPolicy.js";
import {
  _resetActiveProfileForTesting,
  COMPAT_PROFILE,
  GOVERNED_PROFILE,
  type GovernanceProfile,
  resolveProfile,
  setActiveProfile,
} from "../../governance/profile.js";
import { _resetSecretValuesForTesting } from "../../governance/secretValues.js";
import type { ApprovalRequestInput } from "../../recipes/approvalRequest.js";
import {
  clearRegistry,
  type RegisteredTool,
  registerTool,
} from "../../recipes/toolRegistry.js";
import type { RunnerDeps } from "../../recipes/yamlRunner.js";

export const KILL_SWITCH_ENV = "PATCHWORK_FLAG_KILL_SWITCH_WRITES";

export interface Sandbox {
  dir: string;
  restoreEnv: () => void;
}

/** Temp PATCHWORK_HOME + logDir. Call `dispose` in afterAll. */
export function makeSandbox(prefix: string): Sandbox & { dispose: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), `phase0-${prefix}-`));
  const prevHome = process.env.PATCHWORK_HOME;
  process.env.PATCHWORK_HOME = dir;
  const restoreEnv = () => {
    if (prevHome === undefined) delete process.env.PATCHWORK_HOME;
    else process.env.PATCHWORK_HOME = prevHome;
  };
  return {
    dir,
    restoreEnv,
    dispose: () => {
      restoreEnv();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Reset every process-wide seam a scenario may have touched. */
export function resetGovernanceState(): void {
  delete process.env[KILL_SWITCH_ENV];
  setFlag(KILL_SWITCH_WRITES, false);
  _setKillSwitchReaderForTesting(null);
  _resetActiveProfileForTesting();
  _resetSecretValuesForTesting();
  clearRegistry();
}

/** Governed posture, both seams. */
export function governed(): GovernanceProfile {
  setActiveProfile(GOVERNED_PROFILE);
  return GOVERNED_PROFILE;
}

/** Compat posture with the tier gate on (`approvalGate: high`), both seams. */
export function compatHigh(): GovernanceProfile {
  const p = resolveProfile({ approvalGate: "high" });
  setActiveProfile(COMPAT_PROFILE);
  return p;
}

export function baseDeps(
  sandbox: Sandbox,
  extra: Partial<RunnerDeps> = {},
): RunnerDeps {
  return {
    now: () => new Date("2026-09-01T12:00:00Z"),
    logDir: sandbox.dir,
    workdir: sandbox.dir,
    testMode: false,
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

export interface FakeToolSpec {
  id: string;
  isWrite: boolean;
  riskDefault?: "low" | "medium" | "high";
  isConnector?: boolean;
  execute: RegisteredTool["execute"];
}

/** Register a fake tool through the real registry; returns the spied execute. */
export function registerFakeTool(spec: FakeToolSpec) {
  const execute = vi.fn(spec.execute);
  const [namespace] = spec.id.split(".");
  registerTool({
    id: spec.id,
    namespace: namespace ?? spec.id,
    description: `fake ${spec.id}`,
    paramsSchema: { type: "object" },
    outputSchema: { type: "string" },
    riskDefault: spec.riskDefault ?? (spec.isWrite ? "medium" : "low"),
    isWrite: spec.isWrite,
    ...(spec.isConnector !== undefined && { isConnector: spec.isConnector }),
    execute,
  } as RegisteredTool);
  return execute;
}

export interface RecordedApproval {
  toolId: string;
  effective?: string;
  summary?: string;
  params?: Record<string, unknown>;
}

/**
 * Recording approval double. Faithful to `makeRecipeApprovalFn`: a step the
 * runner marked `effective: "ALLOW"` passes without asking; `decide` is the
 * human's answer for everything else. (A double that refused ALLOW steps
 * halted runs before the step under test — and made a secret-leak assertion
 * pass vacuously.)
 */
export function recordingApproval(
  decide: (input: ApprovalRequestInput) => boolean = () => true,
) {
  const calls: RecordedApproval[] = [];
  const fn = vi.fn(async (input: ApprovalRequestInput) => {
    calls.push({
      toolId: input.toolId,
      effective: input.effective,
      summary: input.summary,
      params: input.params,
    });
    if (input.effective === "ALLOW") return true;
    return decide(input);
  });
  return { fn, calls };
}

/** Capturing agent doubles. `reply` is what the "model" answers. */
export function capturingAgent(reply: string | ((prompt: string) => string)) {
  const prompts: string[] = [];
  const cliOpts: Array<Record<string, unknown> | undefined> = [];
  const answer = (p: string) => (typeof reply === "string" ? reply : reply(p));
  const claudeCodeFn = vi.fn(
    async (prompt: string, opts?: Record<string, unknown>) => {
      prompts.push(prompt);
      cliOpts.push(opts);
      return answer(prompt);
    },
  );
  const claudeFn = vi.fn(async (prompt: string, _model: string) => {
    prompts.push(prompt);
    cliOpts.push(undefined);
    return answer(prompt);
  });
  return { claudeCodeFn, claudeFn, prompts, cliOpts };
}

export interface PersistedRun {
  taskId?: string;
  recipeName?: string;
  status?: string;
  errorMessage?: string;
  stepResults?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

/** Every row persisted to `<dir>/runs.jsonl` (empty when nothing was written). */
export function readRunRows(dir: string): PersistedRun[] {
  const file = path.join(dir, "runs.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as PersistedRun);
}

/** Raw text of runs.jsonl — for "this string appears nowhere" assertions. */
export function readRunLogText(dir: string): string {
  const file = path.join(dir, "runs.jsonl");
  return existsSync(file) ? readFileSync(file, "utf-8") : "";
}

/** Every encoding under which a secret could reappear in a sink. */
export function secretForms(secret: string): string[] {
  const b64 = Buffer.from(secret, "utf8").toString("base64");
  return [
    secret,
    encodeURIComponent(secret),
    b64,
    b64.replace(/=+$/, ""),
    Buffer.from(secret, "utf8").toString("base64url"),
    JSON.stringify(secret).slice(1, -1),
  ];
}

/** Assert that NO form of the secret appears in `text`. */
export function expectNoSecret(
  text: string,
  secret: string,
  expect: typeof import("vitest").expect,
): void {
  for (const form of new Set(secretForms(secret))) {
    expect(
      text,
      `secret form must not appear: ${form.slice(0, 6)}…`,
    ).not.toContain(form);
  }
}
