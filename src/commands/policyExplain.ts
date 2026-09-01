/**
 * `patchwork policy explain <recipe> [tool]` — what can this recipe / worker /
 * tool actually do right now, and why?
 *
 * Uses the SAME functions the runtime enforces with:
 *   - `resolveProfile`            (config → profile)            profile.ts
 *   - `toolFactsFor`              (registry → tool facts)       toolFacts.ts
 *   - `resolveAgentContainment` + `stepSandboxRequest`          (agent steps)
 *   - `decideWorkerAction` + `resolveGateOutcome`               (worker gate)
 *   - `parseDataPolicy` + `resolveDestination` + `decideBoundary` (privacy)
 *   - `readKillSwitch`
 *   - `computeEffectivePolicy`    (composition)                 effectivePolicy.ts
 *
 * It never re-implements a rule. `effectivePolicy.test.ts` pins the runner
 * to the same calculation, and this command is the human-readable face of it.
 *
 * Reads config and ledgers; writes nothing.
 */

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  computeEffectivePolicy,
  type EffectivePolicy,
  type EffectivePolicyInput,
  formatEffectivePolicy,
  type PrivacyFacts,
  type TriggerKind,
  type WorkerFacts,
} from "../governance/effectivePolicy.js";
import { readKillSwitch } from "../governance/killSwitchPolicy.js";
import {
  explainPluginPolicy,
  pluginSpecsOf,
  policyInputFromConfig,
} from "../governance/pluginPolicy.js";
import {
  resolveAgentContainment,
  resolveProfile,
} from "../governance/profile.js";
import { toolFactsFor } from "../governance/toolFacts.js";
import { loadConfig } from "../patchworkConfig.js";
import { patchworkPath } from "../patchworkHome.js";
import { stepSandboxRequest } from "../recipes/agentExecutor.js";
import { findYamlRecipePath } from "../recipesHttp.js";
import "../recipes/tools/index.js";

export interface ExplainStep {
  stepId: string;
  toolId: string;
  input: EffectivePolicyInput;
  result: EffectivePolicy;
}

export interface ExplainReport {
  recipe: string;
  file: string;
  trigger: TriggerKind;
  profileMode: string;
  workerId?: string;
  plugins: Array<{ spec: string; allowed: boolean; reason: string }>;
  steps: ExplainStep[];
}

export interface ExplainOptions {
  recipesDir?: string;
  workersDir?: string;
  patchworkDir?: string;
  config?: ReturnType<typeof loadConfig>;
  /** Restrict to steps whose tool id equals this (or "agent"). */
  tool?: string;
}

function resolveRecipeFile(ref: string, recipesDir: string): string | null {
  if (existsSync(ref) && /\.(ya?ml|json)$/.test(ref)) return ref;
  return findYamlRecipePath(recipesDir, ref);
}

export async function explainRecipePolicy(
  ref: string,
  opts: ExplainOptions = {},
): Promise<ExplainReport> {
  const recipesDir = opts.recipesDir ?? patchworkPath("recipes");
  const file = resolveRecipeFile(ref, recipesDir);
  if (!file) {
    throw new Error(`recipe not found: ${ref} (looked in ${recipesDir})`);
  }
  const raw = parseYaml(readFileSync(file, "utf-8")) as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name : ref;
  const trigger = ((raw.trigger as { type?: string } | undefined)?.type ??
    "manual") as TriggerKind;
  let cfg = opts.config;
  if (!cfg) {
    try {
      cfg = loadConfig();
    } catch {
      cfg = undefined;
    }
  }
  const profile = resolveProfile(
    cfg ? { profile: cfg.profile, approvalGate: cfg.approvalGate } : undefined,
  );

  // Worker facts — the same loader + decision the gate uses. Only when the
  // profile (or the live flag) makes the worker gate active; otherwise the
  // manifest is inert and the report says so by omitting the worker.
  let workerId: string | undefined;
  let workerCtx:
    | {
        worker: import("../workers/worker.js").WorkerManifest;
        store: import("../workers/workerLevelStore.js").WorkerLevelStore;
        forbidRules: import("../workers/forbidPolicy.js").ForbidRule[];
      }
    | undefined;
  {
    const { resolveWorkerIdForRecipe } = await import(
      "../recipeOrchestration.js"
    );
    workerId = await resolveWorkerIdForRecipe(name, opts.workersDir);
    const { isEnabled, FLAG_WORKER_AUTONOMY } = await import(
      "../featureFlags.js"
    );
    const gateActive =
      profile.workerAuthority || isEnabled(FLAG_WORKER_AUTONOMY);
    if (workerId && gateActive) {
      const { loadWorkerTrustForRecipe } = await import(
        "../workers/runWorkerShadow.js"
      );
      const trust = loadWorkerTrustForRecipe(name, {
        ...(opts.patchworkDir && { patchworkDir: opts.patchworkDir }),
        ...(opts.workersDir && { workersDir: opts.workersDir }),
      });
      if (trust) {
        const { parseForbidRules } = await import("../workers/forbidPolicy.js");
        workerCtx = {
          worker: trust.worker,
          store: trust.store,
          forbidRules: parseForbidRules(trust.worker.forbids).rules,
        };
      }
    }
  }

  // Privacy registry — parsed the way executeAgent parses it.
  const { parseRegistry, resolveDestination } = await import(
    "../privacy/destinationRegistry.js"
  );
  const { decideBoundary, parseDataPolicy, DEFAULT_CLASSIFICATION } =
    await import("../privacy/dataPolicy.js");
  const registry = parseRegistry(
    (
      cfg as
        | {
            privacy?: import("../privacy/destinationRegistry.js").PrivacyConfig;
          }
        | undefined
    )?.privacy,
  );

  const { decideWorkerAction, resolveGateOutcome } = await import(
    "../workers/workerGate.js"
  );

  const plugins = explainPluginPolicy(
    pluginSpecsOf(raw),
    policyInputFromConfig(profile, cfg),
  ).map((v) => ({ spec: v.spec, allowed: v.allowed, reason: v.reason }));

  const steps: ExplainStep[] = [];
  const rawSteps = Array.isArray(raw.steps)
    ? (raw.steps as Array<Record<string, unknown>>)
    : [];
  let n = 0;
  for (const step of rawSteps) {
    const agent = step.agent as Record<string, unknown> | undefined;
    const toolId = agent
      ? "agent"
      : typeof step.tool === "string"
        ? step.tool
        : undefined;
    const stepId =
      (typeof step.id === "string" && step.id) ||
      (typeof step.into === "string" && step.into) ||
      (agent && typeof agent.into === "string" && agent.into) ||
      `step_${n}`;
    n++;
    if (!toolId) continue; // compound / nested steps are governed by their children
    if (opts.tool && opts.tool !== toolId) continue;

    const containment = agent
      ? resolveAgentContainment(
          profile,
          stepSandboxRequest({
            ...(agent.sandbox !== undefined && {
              sandbox: agent.sandbox as never,
            }),
            ...(Array.isArray(agent.tools) && {
              allowedTools: agent.tools as string[],
            }),
            ...(Array.isArray(agent.disallowedTools) && {
              disallowedTools: agent.disallowedTools as string[],
            }),
            ...(typeof agent.mcpAccess === "boolean" && {
              mcpAccess: agent.mcpAccess,
            }),
          }),
        )
      : undefined;
    const tool = toolFactsFor(
      toolId,
      containment ? { containment } : undefined,
    );

    let worker: WorkerFacts | undefined;
    if (workerCtx && workerId) {
      const decision = decideWorkerAction(
        workerCtx.worker,
        toolId,
        undefined,
        workerCtx.store,
        workerCtx.forbidRules.length > 0
          ? { forbidRules: workerCtx.forbidRules }
          : undefined,
      );
      const resolved = resolveGateOutcome(decision, undefined);
      worker = {
        id: workerId,
        action: decision.action,
        ...(decision.ruleId !== undefined && {
          ruleId: String(decision.ruleId),
        }),
        ...(resolved.standingPermissionId !== undefined && {
          standingPermissionId: resolved.standingPermissionId,
        }),
      };
    }

    let privacy: PrivacyFacts | undefined;
    if (agent && registry.destinations.length > 0) {
      const declared = agent.data_policy;
      const policy =
        declared === undefined
          ? { classification: DEFAULT_CLASSIFICATION }
          : parseDataPolicy(declared);
      const driver =
        typeof agent.driver === "string" ? agent.driver : cfg?.driver;
      const dest = resolveDestination(
        registry,
        driver,
        policy?.classification ?? DEFAULT_CLASSIFICATION,
        cfg?.localEndpoint ? { endpoint: cfg.localEndpoint } : {},
      );
      if (dest) {
        const outcome = policy
          ? decideBoundary(policy, dest.destination, {
              localDestinationAccepts: dest.localDestinationAccepts,
            })
          : {
              decision: "DENY" as const,
              reason: "unrecognised classification",
            };
        privacy = {
          classification: policy?.classification ?? "invalid",
          destination: dest.destination.id,
          decision: outcome.decision,
          ...(outcome.reason !== undefined && { reason: outcome.reason }),
        };
      }
    }

    const input: EffectivePolicyInput = {
      profile,
      recipe: {
        name,
        ...(typeof raw.requireApproval === "boolean" && {
          requireApproval: raw.requireApproval,
        }),
      },
      trigger,
      tool,
      ...(worker && { worker }),
      ...(privacy && { privacy }),
      killSwitch: readKillSwitch(profile),
    };
    steps.push({
      stepId,
      toolId,
      input,
      result: computeEffectivePolicy(input),
    });
  }

  return {
    recipe: name,
    file,
    trigger,
    profileMode: profile.mode,
    ...(workerId && { workerId }),
    plugins,
    steps,
  };
}

export function formatExplainReport(r: ExplainReport): string {
  const out: string[] = [];
  if (r.plugins.length > 0) {
    out.push(`PLUGINS (servers:)`);
    for (const p of r.plugins) {
      out.push(
        `  ${p.allowed ? "ALLOWED" : "REFUSED"}  ${p.spec} — ${p.reason}`,
      );
    }
    out.push("");
  }
  if (r.steps.length === 0) {
    out.push(`RECIPE: ${r.recipe}`);
    out.push(`PROFILE: ${r.profileMode.toUpperCase()}`);
    out.push("No tool or agent steps to explain.");
    return out.join("\n");
  }
  for (const s of r.steps) {
    out.push(`STEP: ${s.stepId}`);
    out.push(formatEffectivePolicy(s.input, s.result));
    out.push("");
  }
  return out.join("\n").trimEnd();
}
