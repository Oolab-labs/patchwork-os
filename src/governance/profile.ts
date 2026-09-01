/**
 * Governance profile — the ONE concept that turns Patchwork's opt-in controls
 * into a coherent posture.
 *
 * Phase 0 finding: every headline control (approval gate, automated-trigger
 * gating, worker authority, policy matrix, agent sandbox, plugin loading, the
 * kill-switch failure mode) was independently opt-in and independently
 * fail-open, so a fresh install enforced nothing while looking governed on the
 * dashboard. This module resolves a single `profile` setting into the existing
 * primitives — it adds no new decision function of its own.
 *
 * Two modes, deliberately only two:
 *
 *   - `compat`   — byte-identical to pre-profile behaviour. This is what an
 *                  install with no `profile` key resolves to, so an existing
 *                  installation never changes behaviour by upgrading.
 *   - `governed` — conservative defaults suitable for real business data.
 *                  `patchwork init` writes this for NEW installs;
 *                  `patchwork profile governed` opts an existing one in.
 *
 * The resolved profile is a plain value. Runtime enforcement, `patchwork
 * policy explain` and `patchwork doctor` all read the SAME resolved value, so
 * the explanation cannot describe a posture the runtime is not applying.
 *
 * Every field below maps to something that already exists; the comment on
 * each names the primitive it feeds. Nothing here is a new flag.
 */

export const PROFILE_MODES = ["governed", "compat"] as const;
export type ProfileMode = (typeof PROFILE_MODES)[number];

export interface GovernanceProfile {
  mode: ProfileMode;
  /** Whether `profile:` was explicitly present in config (vs defaulted). */
  declared: boolean;
  /**
   * Feeds `Server.approvalGate` / `makeRecipeApprovalFn`. Governed raises the
   * operator's setting to at least `"high"`; it never lowers an explicit
   * `"all"`.
   */
  approvalGate: "off" | "high" | "all";
  /**
   * Feeds `RunnerDeps.gateAutomatedRuns`. Governed: cron / webhook / file-watch
   * / git-hook / test-run triggers are consulted exactly like a manual run.
   * Compat: manual only (the worker gate may still set it, as before).
   */
  gateAutomatedRuns: boolean;
  /**
   * Feeds `FLAG_WORKER_AUTONOMY`: a worker manifest that owns a recipe governs
   * it. Compat leaves the flag as the operator set it.
   */
  workerAuthority: boolean;
  /** Feeds `FLAG_ENFORCE_POLICY` (`patchwork.policy.yml`). */
  policyEnforce: boolean;
  /**
   * Feeds the subprocess drivers (`src/drivers/*`): under `enforced` an agent
   * step that declares no `sandbox:` runs contained — read-only tool
   * allowlist, no WebFetch/WebSearch/Bash, allowlisted environment, no bridge
   * MCP access. A recipe may widen this EXPLICITLY per step, and the widening
   * is visible in `policy explain`.
   */
  agentContainment: "enforced" | "opt-in";
  /**
   * Feeds `loadRecipeServers` / recipe install / dashboard save / lint:
   * `allowlist` refuses any `servers:` entry not in `config.plugins.allow`.
   */
  pluginPolicy: "allowlist" | "open";
  /**
   * Feeds `readKillSwitch`: when the kill-switch state cannot be read, treat
   * it as ENGAGED (refuse) rather than released.
   */
  killSwitchFailClosed: boolean;
  /**
   * A write tool whose tier was INFERRED from its name (no explicit
   * `riskDefault`, or a plugin / MCP tool) is queued for approval rather than
   * trusted on the heuristic.
   */
  unknownWriteTools: "gate" | "allow";
  /**
   * A tool id nothing is registered under: governed halts the run (a plugin
   * that failed to load must not produce a green run that did nothing);
   * compat keeps the documented forward-compat SKIP.
   */
  unregisteredTools: "refuse" | "skip";
  /** Connector-derived values are wrapped in an untrusted-content envelope. */
  untrustedEnvelope: boolean;
  /**
   * Whether a recipe's own `requireApproval: false` may switch off the tier
   * gate. Governed: no — a recipe cannot opt itself out of the workspace
   * policy.
   */
  recipeOptOutHonoured: boolean;
}

export interface ProfileConfigInput {
  profile?: unknown;
  approvalGate?: unknown;
}

/**
 * Pure: config → profile. Unknown or absent `profile` ⇒ compat (never a
 * guess). An explicit but unrecognised value is reported by `doctor`, not
 * silently promoted to governed.
 */
export function resolveProfile(cfg: ProfileConfigInput | undefined): GovernanceProfile {
  const raw = cfg?.profile;
  const declared = raw === "governed" || raw === "compat";
  const mode: ProfileMode = raw === "governed" ? "governed" : "compat";
  const configuredGate =
    cfg?.approvalGate === "high" || cfg?.approvalGate === "all" || cfg?.approvalGate === "off"
      ? cfg.approvalGate
      : "off";
  if (mode === "compat") {
    return {
      mode,
      declared,
      approvalGate: configuredGate,
      gateAutomatedRuns: false,
      workerAuthority: false,
      policyEnforce: false,
      agentContainment: "opt-in",
      pluginPolicy: "open",
      killSwitchFailClosed: false,
      unknownWriteTools: "allow",
      unregisteredTools: "skip",
      untrustedEnvelope: false,
      recipeOptOutHonoured: true,
    };
  }
  return {
    mode,
    declared,
    approvalGate: configuredGate === "all" ? "all" : "high",
    gateAutomatedRuns: true,
    workerAuthority: true,
    policyEnforce: true,
    agentContainment: "enforced",
    pluginPolicy: "allowlist",
    killSwitchFailClosed: true,
    unknownWriteTools: "gate",
    unregisteredTools: "refuse",
    untrustedEnvelope: true,
    recipeOptOutHonoured: false,
  };
}

export const COMPAT_PROFILE: GovernanceProfile = Object.freeze(resolveProfile(undefined));
export const GOVERNED_PROFILE: GovernanceProfile = Object.freeze(
  resolveProfile({ profile: "governed" }),
);

export function isGoverned(p: GovernanceProfile | undefined): boolean {
  return p?.mode === "governed";
}

// ---------------------------------------------------------------------------
// Process-wide active profile.
//
// Set ONCE by the bridge at startup from the loaded config (and by the CLI
// verbs that need it). Everything that enforces reads this rather than
// re-deriving from config, so a mid-session config edit cannot leave two
// components disagreeing about the posture. Defaults to compat, which is the
// no-behaviour-change value.
// ---------------------------------------------------------------------------

let ACTIVE: GovernanceProfile = COMPAT_PROFILE;

export function setActiveProfile(p: GovernanceProfile): void {
  ACTIVE = p;
}

export function activeProfile(): GovernanceProfile {
  return ACTIVE;
}

/** Test seam. */
export function _resetActiveProfileForTesting(): void {
  ACTIVE = COMPAT_PROFILE;
}

// ---------------------------------------------------------------------------
// Agent containment — what a spawned CLI agent may touch under a profile.
// ---------------------------------------------------------------------------

/**
 * Tools a contained agent step may use. Read-only by construction: nothing
 * here writes a file, runs a command, or reaches the network. Names are the
 * Claude Code built-in tool names; other drivers map them to their own
 * equivalents (Gemini/Codex have coarser knobs — see each driver).
 */
export const CONTAINED_AGENT_ALLOWED_TOOLS: readonly string[] = Object.freeze([
  "Read",
  "Glob",
  "Grep",
  "LS",
]);

/**
 * Tools that are DENIED in every mode when the profile is governed, even when
 * a recipe widens `allowedTools`. Network egress and shell are the two
 * capabilities that turn a prompt injection into exfiltration; a recipe that
 * genuinely needs them must say so with `sandbox: { network: true }` /
 * `sandbox: { shell: true }`, which `policy explain` reports as a widening.
 */
export const CONTAINED_AGENT_DENIED_TOOLS: readonly string[] = Object.freeze([
  "WebFetch",
  "WebSearch",
  "Bash",
]);

export interface AgentContainment {
  /** True when the driver must apply the allowlist (not merely the deny list). */
  enforced: boolean;
  allowedTools: string[];
  deniedTools: string[];
  /** Pass only an explicit environment allowlist to the child process. */
  envAllowlist: boolean;
  /** Whether the child may reach the bridge's own MCP tool surface. */
  mcpAccess: boolean;
  /** Human-readable widenings the recipe requested, for `policy explain`. */
  widenings: string[];
}

export interface StepSandboxRequest {
  /** Recipe-declared `sandbox: true` / `allowedTools:` (existing fields). */
  sandbox?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Explicit widenings a recipe may request under a governed profile. */
  network?: boolean;
  shell?: boolean;
  mcpAccess?: boolean;
}

/**
 * Pure: (profile, step request) → containment the driver must apply.
 *
 * Under `compat` this reproduces today's behaviour exactly: containment only
 * when the step opted in via `sandbox: true`. Under `governed` the default is
 * contained, and each widening is recorded so the explanation can show it.
 */
export function resolveAgentContainment(
  profile: GovernanceProfile,
  req: StepSandboxRequest | undefined,
): AgentContainment {
  const widenings: string[] = [];
  if (profile.agentContainment !== "enforced") {
    const enforced = req?.sandbox === true;
    return {
      enforced,
      allowedTools: enforced ? [...(req?.allowedTools ?? [])] : [],
      deniedTools: [...(req?.disallowedTools ?? [])],
      envAllowlist: false,
      mcpAccess: req?.mcpAccess === true,
      widenings,
    };
  }
  const allowed = new Set<string>(CONTAINED_AGENT_ALLOWED_TOOLS);
  for (const t of req?.allowedTools ?? []) {
    if (!allowed.has(t)) widenings.push(`allowedTools+${t}`);
    allowed.add(t);
  }
  const denied = new Set<string>(CONTAINED_AGENT_DENIED_TOOLS);
  for (const t of req?.disallowedTools ?? []) denied.add(t);
  if (req?.network === true) {
    denied.delete("WebFetch");
    denied.delete("WebSearch");
    widenings.push("network");
  }
  if (req?.shell === true) {
    denied.delete("Bash");
    widenings.push("shell");
  }
  // A deny always beats an allow — a recipe cannot re-allow what it is denied.
  for (const t of denied) allowed.delete(t);
  const mcpAccess = req?.mcpAccess === true;
  if (mcpAccess) widenings.push("mcpAccess");
  return {
    enforced: true,
    allowedTools: [...allowed],
    deniedTools: [...denied],
    envAllowlist: true,
    mcpAccess,
    widenings,
  };
}
