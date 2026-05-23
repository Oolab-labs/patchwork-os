/**
 * `patchwork doctor` CLI verb.
 *
 * Runs a subset of bridge health checks that are safe without a live bridge
 * connection (no extensionClient, no ProbeResults). Reports workspace path,
 * git binary, lock file, and automation policy readability.
 *
 * No changes to src/index.ts — wire routing separately.
 */

import { runBridgeHealthChecks } from "../tools/bridgeDoctor.js";

export interface DoctorOptions {
  workspace?: string;
  port?: number;
  automationPolicyPath?: string;
  json?: boolean;
}

export interface DoctorResult {
  ok: boolean;
  checks: Array<{
    name: string;
    status: "ok" | "warn" | "fail";
    detail?: string;
    suggestion?: string;
  }>;
}

/**
 * Run CLI-safe bridge health checks and return a structured result.
 *
 * Maps `CheckResult` (which uses `"error"` for failures) to the public
 * `DoctorResult` shape (which uses `"fail"`). Warns are preserved as `"warn"`.
 * Skipped checks are surfaced as `"ok"` (they are non-issues from the CLI
 * perspective).
 *
 * `ok` is `true` when no check has `status === "fail"`.
 */
export async function runDoctor(
  options: DoctorOptions = {},
): Promise<DoctorResult> {
  const workspace = options.workspace ?? process.cwd();

  const raw = await runBridgeHealthChecks(workspace, {
    port: options.port,
    automationPolicyPath: options.automationPolicyPath,
  });

  const checks = raw.map((c) => {
    let status: "ok" | "warn" | "fail";
    if (c.status === "error") {
      status = "fail";
    } else if (c.status === "warn") {
      status = "warn";
    } else {
      // "ok" | "skip" — both treated as non-failing from CLI perspective
      status = "ok";
    }

    const entry: DoctorResult["checks"][number] = { name: c.name, status };
    if (c.detail !== undefined) entry.detail = c.detail;
    if (c.suggestion !== undefined) entry.suggestion = c.suggestion;
    return entry;
  });

  return {
    ok: checks.every((c) => c.status !== "fail"),
    checks,
  };
}
