/**
 * Governance posture for `patchwork doctor` — "am I actually running
 * governed?"
 *
 * Every line is read from RUNTIME-EFFECTIVE state, never from what the config
 * file says it wants: the resolved profile, the live flag values, the plugin
 * scan of installed recipes, the destination registry as parsed, the
 * secret-value registry count. A line that could be green while the runtime
 * did something else would be worse than no line.
 *
 * Output names no recipe and prints no value — counts and verdicts only —
 * so it is safe to paste.
 */

import { readdirSync } from "node:fs";
import {
  FLAG_ENFORCE_POLICY,
  FLAG_WORKER_AUTONOMY,
  isEnabled,
} from "../featureFlags.js";
import { loadConfig } from "../patchworkConfig.js";
import { patchworkPath } from "../patchworkHome.js";
import { parseRegistry } from "../privacy/destinationRegistry.js";
import { readKillSwitch } from "./killSwitchPolicy.js";
import {
  policyInputFromConfig,
  scanInstalledRecipePlugins,
} from "./pluginPolicy.js";
import { type GovernanceProfile, resolveProfile } from "./profile.js";
import { secretValueCount } from "./secretValues.js";

export interface GovernanceLine {
  key: string;
  label: string;
  value: string;
  /** ok = contributes to GOVERNED; warn = informational; fail = a NOT GOVERNED reason. */
  status: "ok" | "warn" | "fail";
  reason?: string;
}

export interface GovernanceReport {
  profile: GovernanceProfile;
  governed: boolean;
  lines: GovernanceLine[];
  reasons: string[];
}

export interface GovernanceReportOpts {
  /** Config to judge (default: `loadConfig()`). Tests inject. */
  config?: ReturnType<typeof loadConfig>;
  /** Live flag reader (default: featureFlags.isEnabled). Tests inject. */
  isFlagOn?: (id: string) => boolean;
  recipesDir?: string;
  workersDir?: string;
  /**
   * Whether this process IS the bridge (flags resolved at startup). From the
   * CLI, flags are re-derived from the profile — the CLI cannot see a live
   * bridge's memory — and the report says so.
   */
  live?: boolean;
}

export function governanceReport(
  opts: GovernanceReportOpts = {},
): GovernanceReport {
  let cfg: ReturnType<typeof loadConfig> | undefined = opts.config;
  let configError: string | undefined;
  if (!cfg) {
    try {
      cfg = loadConfig();
    } catch (err) {
      configError = err instanceof Error ? err.message : String(err);
    }
  }
  const profile = resolveProfile(
    cfg ? { profile: cfg.profile, approvalGate: cfg.approvalGate } : undefined,
  );
  const lines: GovernanceLine[] = [];
  const reasons: string[] = [];
  const push = (l: GovernanceLine) => {
    lines.push(l);
    if (l.status === "fail" && l.reason) reasons.push(l.reason);
  };

  // 1. Profile.
  if (configError) {
    push({
      key: "profile",
      label: "Governed profile",
      value: "UNKNOWN",
      status: "fail",
      reason: `config.json unreadable (${configError}); runtime resolves to compat`,
    });
  } else {
    push({
      key: "profile",
      label: "Governed profile",
      value:
        profile.mode === "governed"
          ? "ON"
          : profile.declared
            ? "OFF (compat)"
            : "OFF (no profile: key — compat)",
      status: profile.mode === "governed" ? "ok" : "fail",
      reason:
        profile.mode === "governed"
          ? undefined
          : "profile is compat: approval, automated-run gating, containment, plugin allowlist and fail-closed kill switch are all off by default (`patchwork profile governed` to opt in)",
    });
  }

  // 2. Approval gate.
  push({
    key: "approvalGate",
    label: "Approval gate",
    value:
      profile.approvalGate === "off" ? "OFF" : `ON (${profile.approvalGate})`,
    status: profile.approvalGate === "off" ? "fail" : "ok",
    reason:
      profile.approvalGate === "off"
        ? "approval gate is off: no tool call is ever queued for a human"
        : undefined,
  });

  // 3. Automated runs.
  push({
    key: "automatedRuns",
    label: "Automated runs",
    value: profile.gateAutomatedRuns ? "GATED" : "NOT GATED (manual runs only)",
    status: profile.gateAutomatedRuns ? "ok" : "fail",
    reason: profile.gateAutomatedRuns
      ? undefined
      : "cron / webhook / file-watch / git-hook recipes bypass approval",
  });

  // 4. Worker authority — live flag if we are the bridge, else profile-derived.
  const flagOn = opts.isFlagOn ?? isEnabled;
  const workerOn = opts.live
    ? flagOn(FLAG_WORKER_AUTONOMY)
    : profile.workerAuthority || flagOn(FLAG_WORKER_AUTONOMY);
  const policyOn = opts.live
    ? flagOn(FLAG_ENFORCE_POLICY)
    : profile.policyEnforce || flagOn(FLAG_ENFORCE_POLICY);
  push({
    key: "workerAuthority",
    label: "Worker authority",
    value: workerOn ? "ENFORCED" : "INERT (manifests are reporting-only)",
    status: workerOn ? "ok" : "fail",
    reason: workerOn
      ? undefined
      : "worker manifests (owns / forbids / ceiling) govern nothing",
  });
  push({
    key: "policyMatrix",
    label: "Policy matrix",
    value: policyOn ? "ENFORCED (patchwork.policy.yml)" : "OFF",
    status: policyOn ? "ok" : "warn",
  });

  // 5. Privacy destinations — parsed registry, not the raw block.
  let destCount = 0;
  let remoteCount = 0;
  let registryError: string | undefined;
  try {
    const reg = parseRegistry(
      (
        cfg as
          | {
              privacy?: import("../privacy/destinationRegistry.js").PrivacyConfig;
            }
          | undefined
      )?.privacy,
    );
    destCount = reg.destinations.length;
    remoteCount = reg.destinations.filter((d) => d.type === "remote").length;
    if (reg.invalid.length > 0) {
      registryError = `${reg.invalid.length} destination(s) failed to parse`;
    }
  } catch (err) {
    registryError = err instanceof Error ? err.message : String(err);
  }
  push({
    key: "privacyDestinations",
    label: "Privacy destinations",
    value: registryError
      ? `ERROR (${registryError})`
      : destCount === 0
        ? "NONE REGISTERED (boundary inert)"
        : `${destCount} REGISTERED (${remoteCount} remote)`,
    status: registryError ? "fail" : destCount === 0 ? "fail" : "ok",
    reason: registryError
      ? `privacy destinations: ${registryError}`
      : destCount === 0
        ? "no model destination registered: agent steps dispatch anywhere with no data-boundary decision"
        : undefined,
  });

  // 6. Agent containment.
  push({
    key: "agentContainment",
    label: "Agent sandbox",
    value:
      profile.agentContainment === "enforced"
        ? "ENFORCED (read-only tools, no network/shell, env allowlist)"
        : "OPT-IN per step",
    status: profile.agentContainment === "enforced" ? "ok" : "fail",
    reason:
      profile.agentContainment === "enforced"
        ? undefined
        : "subprocess agents run with --dangerously-skip-permissions, WebFetch and the full environment unless a step sets sandbox: true",
  });

  // 7. Plugin policy + scan.
  const recipesDir = opts.recipesDir ?? patchworkPath("recipes");
  let scanText = "";
  let refused = 0;
  let scanned = 0;
  try {
    const scan = scanInstalledRecipePlugins(
      recipesDir,
      policyInputFromConfig(profile, cfg),
    );
    scanned = scan.recipesScanned;
    refused = scan.refusedSpecs;
    scanText = ` — ${scanned} recipe(s) scanned, ${refused} plugin spec(s) refused`;
  } catch {
    scanText = " — recipes dir not scanned";
  }
  push({
    key: "pluginPolicy",
    label: "Plugin policy",
    value:
      (profile.pluginPolicy === "allowlist"
        ? "ALLOWLIST"
        : "OPEN (any servers: entry loads in-process)") + scanText,
    status:
      profile.pluginPolicy !== "allowlist"
        ? "fail"
        : refused > 0
          ? "fail"
          : "ok",
    reason:
      profile.pluginPolicy !== "allowlist"
        ? "recipe servers: entries load arbitrary in-process code"
        : refused > 0
          ? `${refused} installed recipe plugin spec(s) are not allowlisted and will be refused at run time (run \`recipe doctor\` for names)`
          : undefined,
  });

  // 8. Kill switch.
  const ks = readKillSwitch(profile);
  push({
    key: "killSwitch",
    label: "Kill switch",
    value: ks.engaged
      ? `ENGAGED (${ks.reason})`
      : profile.killSwitchFailClosed
        ? "READY (fails closed)"
        : "READY (fails OPEN if unreadable)",
    status:
      ks.reason === "unreadable_fail_open"
        ? "fail"
        : profile.killSwitchFailClosed
          ? "ok"
          : "warn",
    reason:
      ks.reason === "unreadable_fail_open"
        ? "kill-switch state unreadable and the compat profile treats that as released"
        : undefined,
  });

  // 9. Secret redaction.
  const n = secretValueCount();
  push({
    key: "secretRedaction",
    label: "Secret redaction",
    value: `ACTIVE (key-based + ${n} value(s) registered${opts.live ? "" : " in this process"})`,
    status: "ok",
  });

  // 10. Untrusted envelope.
  push({
    key: "untrustedEnvelope",
    label: "Untrusted content",
    value: profile.untrustedEnvelope
      ? "ENVELOPED in agent prompts"
      : "RAW (connector output rendered as-is)",
    status: profile.untrustedEnvelope ? "ok" : "warn",
  });

  // 11. Worker manifests present (informational).
  let workerCount = 0;
  try {
    workerCount = readdirSync(
      opts.workersDir ?? patchworkPath("workers"),
    ).filter((f) => /\.worker\.ya?ml$/.test(f)).length;
  } catch {
    workerCount = 0;
  }
  push({
    key: "workers",
    label: "Worker manifests",
    value: String(workerCount),
    status: "warn",
  });

  const governed = lines.every((l) => l.status !== "fail");
  return { profile, governed, lines, reasons };
}

export function formatGovernanceReport(r: GovernanceReport): string {
  const out: string[] = ["PATCHWORK GOVERNANCE", ""];
  for (const l of r.lines) {
    out.push(`${l.label.padEnd(24)}${l.value}`);
  }
  out.push("");
  out.push(`STATUS: ${r.governed ? "GOVERNED" : "NOT GOVERNED"}`);
  if (!r.governed) {
    out.push("");
    out.push("Reasons:");
    for (const reason of r.reasons) out.push(`  * ${reason}`);
  }
  return out.join("\n");
}
