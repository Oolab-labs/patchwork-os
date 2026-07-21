/**
 * `patchwork codex doctor` CLI verb.
 *
 * Diagnoses whether ~/.codex/config.toml is correctly wired up to talk to
 * this bridge: does the config file exist, does it have a
 * [mcp_servers.claude-ide-bridge] entry, is the entry's URL well-formed, is
 * a bridge actually running, and — if so — do the config's port and Bearer
 * token still match the live bridge's current lock file? A bridge restart
 * rotates its port (when none is fixed) and, without --fixed-token, its
 * auth token too, silently staling out a previously-generated
 * ~/.codex/config.toml with no error until Codex's next tool call 401s.
 *
 * Fail-soft, mirroring `recipe doctor`'s composition: static config checks
 * always run; the live-bridge checks degrade to a warning (not a failure)
 * when no bridge is currently running, since "config valid but bridge not
 * started yet" is not itself a misconfiguration.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BridgeLockInfo } from "../bridgeLockDiscovery.js";
import { findBridgeLock } from "../bridgeLockDiscovery.js";

export interface CodexDoctorOptions {
  /** Override for ~/.codex/config.toml — primarily for tests. */
  configPath?: string;
  /** Override for bridge-lock discovery — primarily for tests. */
  findBridgeLockFn?: () => BridgeLockInfo | null;
}

export interface CodexDoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail?: string;
  suggestion?: string;
}

export interface CodexDoctorResult {
  ok: boolean;
  checks: CodexDoctorCheck[];
}

const BRIDGE_ENTRY_HEADER = "[mcp_servers.claude-ide-bridge]";
const GEN_CONFIG_SUGGESTION = "Run: bash scripts/gen-mcp-config.sh codex";

/** Slice out just the [mcp_servers.claude-ide-bridge] table body — up to the
 * next top-level `[section]` header or EOF. Minimal hand-rolled parse (no
 * TOML dependency) since we only ever need two fields out of a config shape
 * this bridge itself generates. */
function extractBridgeSection(toml: string): string | null {
  const idx = toml.indexOf(BRIDGE_ENTRY_HEADER);
  if (idx === -1) return null;
  const rest = toml.slice(idx + BRIDGE_ENTRY_HEADER.length);
  const nextSectionIdx = rest.search(/\n\s*\[/);
  return nextSectionIdx === -1 ? rest : rest.slice(0, nextSectionIdx);
}

function extractField(section: string, re: RegExp): string | null {
  return section.match(re)?.[1] ?? null;
}

export async function runCodexDoctor(
  options: CodexDoctorOptions = {},
): Promise<CodexDoctorResult> {
  const configPath =
    options.configPath ?? path.join(os.homedir(), ".codex", "config.toml");
  const findLock = options.findBridgeLockFn ?? findBridgeLock;
  const checks: CodexDoctorCheck[] = [];

  let toml: string | null = null;
  if (!fs.existsSync(configPath)) {
    checks.push({
      name: "Codex config file",
      status: "fail",
      detail: `not found at ${configPath}`,
      suggestion: GEN_CONFIG_SUGGESTION,
    });
  } else {
    try {
      toml = fs.readFileSync(configPath, "utf-8");
      checks.push({
        name: "Codex config file",
        status: "ok",
        detail: configPath,
      });
    } catch (err) {
      checks.push({
        name: "Codex config file",
        status: "fail",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let sectionUrl: string | null = null;
  let sectionToken: string | null = null;
  if (toml !== null) {
    const section = extractBridgeSection(toml);
    if (section === null) {
      checks.push({
        name: "Bridge MCP server entry",
        status: "fail",
        detail: `no ${BRIDGE_ENTRY_HEADER} section found`,
        suggestion: GEN_CONFIG_SUGGESTION,
      });
    } else {
      sectionUrl = extractField(section, /url\s*=\s*"([^"]+)"/);
      sectionToken = extractField(
        section,
        /Authorization"?\s*=\s*"Bearer ([^"]+)"/,
      );
      if (sectionUrl === null) {
        checks.push({
          name: "Bridge MCP server entry",
          status: "fail",
          detail: "section found but no url field",
          suggestion: GEN_CONFIG_SUGGESTION,
        });
      } else if (!/^https?:\/\/[^/]+\/mcp$/.test(sectionUrl)) {
        checks.push({
          name: "Bridge MCP server entry",
          status: "warn",
          detail: `unusual url shape: ${sectionUrl} (expected http(s)://host:port/mcp)`,
        });
      } else {
        checks.push({
          name: "Bridge MCP server entry",
          status: "ok",
          detail: sectionUrl,
        });
      }
      if (sectionToken === null) {
        checks.push({
          name: "Bridge auth token",
          status: "warn",
          detail: 'no Authorization: "Bearer ..." header found in config',
        });
      }
    }
  }

  let liveLock: BridgeLockInfo | null = null;
  try {
    liveLock = findLock();
  } catch {
    liveLock = null;
  }

  if (liveLock === null) {
    checks.push({
      name: "Live bridge",
      status: "warn",
      detail: "no running bridge discovered",
      suggestion: "Start the bridge, then re-run this check",
    });
  } else {
    checks.push({
      name: "Live bridge",
      status: "ok",
      detail: `port ${liveLock.port}, workspace ${liveLock.workspace}`,
    });

    if (sectionUrl !== null) {
      const expectedSuffix = `:${liveLock.port}/mcp`;
      if (!sectionUrl.endsWith(expectedSuffix)) {
        checks.push({
          name: "Config port matches live bridge",
          status: "fail",
          detail: `config points at ${sectionUrl}, live bridge is listening on port ${liveLock.port}`,
          suggestion: `${GEN_CONFIG_SUGGESTION} (config is stale — the bridge restarted on a different port)`,
        });
      } else {
        checks.push({ name: "Config port matches live bridge", status: "ok" });
      }
    }

    if (sectionToken !== null) {
      if (sectionToken !== liveLock.authToken) {
        checks.push({
          name: "Config auth token matches live bridge",
          status: "fail",
          detail:
            "Bearer token in the config does not match the running bridge's current token",
          suggestion: `${GEN_CONFIG_SUGGESTION} (token is stale)`,
        });
      } else {
        checks.push({
          name: "Config auth token matches live bridge",
          status: "ok",
        });
      }
    }
  }

  return {
    ok: checks.every((c) => c.status !== "fail"),
    checks,
  };
}
