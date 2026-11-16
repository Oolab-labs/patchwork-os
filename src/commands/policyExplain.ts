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
  FLAG_BLOCK_RECIPE_ALLOW_PRIVATE,
  FLAG_ENFORCE_ALLOWWRITES,
  isEnabled,
} from "../featureFlags.js";
import {
  computeEffectivePolicy,
  type EffectivePolicy,
  type EffectivePolicyInput,
  formatEffectivePolicy,
  type PrivacyFacts,
  policyTriggerFor,
  recipePrivateBypassHonoured,
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
import {
  fanOutChildReversibilityCeiling,
  fanOutChildToolId,
} from "../recipes/fanOutChild.js";
import {
  explainRollbackability,
  reversibilityCeilingFor,
} from "../recipes/fileWriteRollbackability.js";
import { findYamlRecipePath } from "../recipesHttp.js";
import type { RunStartSource } from "../runLog.js";
import "../recipes/tools/index.js";

export interface ExplainStep {
  stepId: string;
  /** Position of the step in the recipe's `steps:` list (0-based). */
  index: number;
  /** The tool the step is GATED as: for a `fan_out`, its per-item child. */
  toolId: string;
  /**
   * Present only when the step dispatches a different tool from the one it is
   * gated as — today, `fan_out`. The runners gate a fan_out as its child
   * (`fanOutChild.ts`); the explanation follows them, and names both.
   */
  dispatchedToolId?: string;
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
  /**
   * Explain a run STARTED this way rather than the way the recipe fires on
   * its own. `manual` is a dashboard "Run now" — for a recipe that declares
   * `cron`, that start is evaluated as manual, exactly as the runner does
   * (`policyTriggerFor`). Absent ⇒ the declared trigger.
   */
  start?: RunStartSource;
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
  // The trigger the RUNNER evaluates. A top-level chained run is the
  // user-dispatched case, and `chainedRunner` passes `trigger: "manual"` to
  // `computeEffectivePolicy` for it (cron and webhooks route to the flat
  // runner, never to a chained recipe). Explaining it as "chained" made the
  // compat profile report its steps as ungated while the runner gated them.
  const evaluatedTrigger: TriggerKind =
    trigger === "chained" ? "manual" : policyTriggerFor(trigger, opts.start);
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
    const { workerGateEnabled } = await import(
      "../governance/workerAuthority.js"
    );
    const gateActive = workerGateEnabled(profile);
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
    const index = n;
    n++;
    if (!toolId) continue; // compound / nested steps are governed by their children
    // Gate a fan_out as the tool it runs per item, exactly as both runners do
    // (yamlRunner / chainedRunner via fanOutChild.ts). Explaining it as
    // `fan_out` itself said "tool does not write" and ALLOWED for a step the
    // runner held for a human.
    const fanOutChild = agent ? undefined : fanOutChildToolId(step);
    const gateToolId = fanOutChild ?? toolId;
    if (opts.tool && opts.tool !== toolId && opts.tool !== gateToolId) continue;

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
    // INV-1: same instance ceiling the runner applies (no run ⇒ no rollback
    // log ⇒ an fs write is not reversible).
    const ceiling = fanOutChild
      ? fanOutChildReversibilityCeiling(fanOutChild)
      : reversibilityCeilingFor(explainRollbackability(toolId));
    const tool = toolFactsFor(
      gateToolId,
      containment ? { containment } : undefined,
      ceiling ? { reversibilityCeiling: ceiling } : undefined,
    );

    let worker: WorkerFacts | undefined;
    if (workerCtx && workerId) {
      const decision = decideWorkerAction(
        workerCtx.worker,
        gateToolId,
        undefined,
        workerCtx.store,
        workerCtx.forbidRules.length > 0 || ceiling
          ? {
              ...(workerCtx.forbidRules.length > 0 && {
                forbidRules: workerCtx.forbidRules,
              }),
              ...(ceiling && { reversibilityCeiling: ceiling }),
            }
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
      trigger: evaluatedTrigger,
      tool,
      ...(worker && { worker }),
      ...(privacy && { privacy }),
      killSwitch: readKillSwitch(profile),
      allowWrites: Array.isArray(raw.allowWrites)
        ? (raw.allowWrites as unknown[]).filter(
            (e): e is string => typeof e === "string",
          )
        : [],
      writeAckFlagOn: isEnabled(FLAG_ENFORCE_ALLOWWRITES),
      ...(toolId === "http.post" && {
        privateNetwork: {
          recipeBypassHonoured: recipePrivateBypassHonoured(
            profile,
            isEnabled(FLAG_BLOCK_RECIPE_ALLOW_PRIVATE),
          ),
        },
      }),
    };
    steps.push({
      stepId,
      index,
      toolId: gateToolId,
      ...(fanOutChild && { dispatchedToolId: toolId }),
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
    const block = formatEffectivePolicy(s.input, s.result);
    // Name both tools for a fan_out: the step dispatches `fan_out`, and is
    // judged as the child it runs once per item.
    out.push(
      s.dispatchedToolId
        ? block.replace(
            `\nTOOL: ${s.toolId}\n`,
            `\nTOOL: ${s.dispatchedToolId} → ${s.toolId} (once per item)\n`,
          )
        : block,
    );
    out.push("");
  }
  return out.join("\n").trimEnd();
}
