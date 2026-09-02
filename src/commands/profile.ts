/**
 * `patchwork profile [show|governed|compat]` — read or set the governance
 * profile in config.json.
 *
 * Setting writes ONE key. Everything the profile implies is resolved at
 * bridge startup from that key (src/governance/profile.ts), so there is no
 * second place the posture can be recorded and drift. A running bridge must
 * be restarted for the change to take effect; the command says so.
 */

import {
  formatGovernanceReport,
  governanceReport,
} from "../governance/doctorReport.js";
import {
  PROFILE_MODES,
  type ProfileMode,
  resolveProfile,
} from "../governance/profile.js";
import { loadConfig, saveConfig } from "../patchworkConfig.js";

export interface ProfileCommandResult {
  ok: boolean;
  text: string;
  exitCode: number;
}

export function runProfileCommand(
  args: string[],
  opts: { configPath?: string } = {},
): ProfileCommandResult {
  const verb = args[0] ?? "show";
  if (verb === "--help" || verb === "-h") {
    return {
      ok: true,
      exitCode: 0,
      text:
        "Usage: patchwork profile [show|governed|compat] [--json]\n\n" +
        "  show       print the resolved governance posture (same lines as `patchwork doctor`)\n" +
        "  governed   set profile: governed in config.json — approval gate ≥ high, automated\n" +
        "             triggers gated, worker authority + policy matrix enforced, agent steps\n" +
        "             contained, recipe plugins allowlisted, kill switch fails closed\n" +
        "  compat     set profile: compat — byte-identical to pre-profile behaviour\n\n" +
        "A running bridge must be restarted (launchctl kickstart …) to pick up a change.\n",
    };
  }
  if (verb === "show") {
    const json = args.includes("--json");
    let cfg: ReturnType<typeof loadConfig> | undefined;
    try {
      cfg = loadConfig(opts.configPath);
    } catch {
      cfg = undefined;
    }
    const report = governanceReport(cfg ? { config: cfg } : {});
    return {
      ok: true,
      exitCode: report.governed ? 0 : 1,
      text: json
        ? JSON.stringify(
            {
              profile: report.profile.mode,
              governed: report.governed,
              lines: report.lines,
              reasons: report.reasons,
            },
            null,
            2,
          )
        : formatGovernanceReport(report),
    };
  }
  if (!(PROFILE_MODES as readonly string[]).includes(verb)) {
    return {
      ok: false,
      exitCode: 2,
      text: `[profile] unknown verb "${verb}"; expected show | governed | compat\n`,
    };
  }
  const mode = verb as ProfileMode;
  let cfg: ReturnType<typeof loadConfig>;
  try {
    cfg = loadConfig(opts.configPath);
  } catch (err) {
    return {
      ok: false,
      exitCode: 1,
      text: `[profile] cannot read config.json: ${err instanceof Error ? err.message : String(err)}\n`,
    };
  }
  const before = cfg.profile;
  saveConfig({ ...cfg, profile: mode }, opts.configPath);
  const resolved = resolveProfile({
    profile: mode,
    approvalGate: cfg.approvalGate,
  });
  const lines = [
    `[profile] ${before === undefined ? "(unset)" : before} → ${mode}`,
    mode === "governed"
      ? `[profile] governed: approval gate ${resolved.approvalGate}, automated triggers gated, worker authority + policy matrix enforced, agent steps contained, plugins allowlisted, kill switch fails closed`
      : "[profile] compat: behaviour is byte-identical to a pre-profile install",
    "[profile] restart the bridge for this to take effect; `patchwork doctor` shows the live posture",
  ];
  return { ok: true, exitCode: 0, text: `${lines.join("\n")}\n` };
}
