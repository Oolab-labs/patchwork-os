/**
 * patchwork.policy.yml — deterministic, non-LLM security boundary.
 *
 * This is NOT a prompt or an LLM instruction. It's a rigid, machine-checked
 * permissions matrix, evaluated in `evaluateInProcessGate` (riskSignals.ts)
 * BEFORE the trust/approval gate even runs. A policy violation is refused
 * outright — it never reaches the Approval Queue, unlike a gated action
 * (which is held for human review). Even a fully-trusted, L4 worker cannot
 * cross a policy boundary; policy and trust are independent axes.
 *
 * Fail-closed on a malformed file: if `patchwork.policy.yml` exists but
 * fails to parse, every checked action is denied rather than silently
 * running unrestricted — a typo in the policy file must never be
 * indistinguishable from "no policy configured". A MISSING file is treated
 * as "no policy configured" (opt-in feature, existing behavior unchanged).
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { minimatch } from "minimatch";
import { parse as parseYaml } from "yaml";

export interface PatchworkPolicyDefaults {
  /** Path globs never readable/writable, any tool, any worker. */
  forbiddenPaths: string[];
  /** Outbound network hosts allowed for http-namespace / sendHttpRequest-style tools. Empty = no extra restriction beyond the existing SSRF guard. */
  allowedNetworkHosts: string[];
  /** Terminal command allowlist for runCommand/runInTerminal. Empty = no extra restriction beyond the bridge's existing command allowlist. */
  allowedCommands: string[];
}

export interface PatchworkWorkerPolicy {
  /** Tool ids this worker may call. Absent = no additional restriction (defaults still apply). Present = worker is restricted to exactly this list. */
  allowedTools?: string[];
}

export interface PatchworkPolicy {
  version: number;
  defaults: PatchworkPolicyDefaults;
  /** Keyed by worker id (matches `id:` in the worker's *.worker.yaml manifest). */
  workers: Record<string, PatchworkWorkerPolicy>;
}

const DEFAULT_POLICY: PatchworkPolicy = {
  version: 1,
  defaults: {
    forbiddenPaths: [],
    allowedNetworkHosts: [],
    allowedCommands: [],
  },
  workers: {},
};

function asStringArray(v: unknown, field: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return v;
}

/** Parse + validate a raw parsed-YAML object into a PatchworkPolicy. Throws on any structural error — callers decide fail-closed handling. */
export function parsePolicy(raw: unknown): PatchworkPolicy {
  if (raw === null || typeof raw !== "object") {
    throw new Error("policy file must be a YAML mapping");
  }
  const obj = raw as Record<string, unknown>;
  const version = obj.version;
  if (version !== 1) {
    throw new Error(
      `policy version must be 1 (got ${JSON.stringify(version)})`,
    );
  }

  const defaultsRaw = (obj.defaults ?? {}) as Record<string, unknown>;
  const defaults: PatchworkPolicyDefaults = {
    forbiddenPaths: asStringArray(
      defaultsRaw.forbiddenPaths,
      "defaults.forbiddenPaths",
    ),
    allowedNetworkHosts: asStringArray(
      defaultsRaw.allowedNetworkHosts,
      "defaults.allowedNetworkHosts",
    ),
    allowedCommands: asStringArray(
      defaultsRaw.allowedCommands,
      "defaults.allowedCommands",
    ),
  };

  const workersRaw = (obj.workers ?? {}) as Record<string, unknown>;
  const workers: Record<string, PatchworkWorkerPolicy> = {};
  for (const [workerId, w] of Object.entries(workersRaw)) {
    if (w === null || typeof w !== "object") {
      throw new Error(`workers.${workerId} must be a mapping`);
    }
    const wObj = w as Record<string, unknown>;
    workers[workerId] = {
      ...(wObj.allowedTools !== undefined && {
        allowedTools: asStringArray(
          wObj.allowedTools,
          `workers.${workerId}.allowedTools`,
        ),
      }),
    };
  }

  return { version, defaults, workers };
}

export type PolicyLoadResult =
  | { ok: true; policy: PatchworkPolicy }
  | { ok: false; error: string };

/**
 * Load `patchwork.policy.yml` from a directory (typically the workspace
 * root). Returns `{ ok: true, policy: DEFAULT_POLICY }` (i.e. no
 * restriction) when the file is absent — this is an opt-in feature.
 * Returns `{ ok: false }` when the file exists but fails to parse —
 * callers MUST treat this as fail-closed (deny), never as "no policy".
 */
export function loadPolicyFile(workspaceDir: string): PolicyLoadResult {
  const filePath = path.join(workspaceDir, "patchwork.policy.yml");
  if (!existsSync(filePath)) {
    return { ok: true, policy: DEFAULT_POLICY };
  }
  try {
    const policy = parsePolicy(parseYaml(readFileSync(filePath, "utf-8")));
    return { ok: true, policy };
  } catch (err) {
    return {
      ok: false,
      error: `patchwork.policy.yml is malformed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export interface PolicyCheckResult {
  allowed: boolean;
  /** Populated only when allowed=false — the specific rule that blocked the call. */
  reason?: string;
}

/**
 * Extract candidate filesystem path values from a tool call's params.
 * Deliberately broad (checks several common key names) rather than
 * per-tool-aware — a false-positive scan (checking a param that isn't
 * really a path) costs nothing; a false negative (missing a real path
 * param) defeats the whole boundary.
 */
const PATH_PARAM_KEYS = [
  "path",
  "filePath",
  "file",
  "cwd",
  "workdir",
  "directory",
];

function extractPathCandidates(params: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of PATH_PARAM_KEYS) {
    const v = params[key];
    if (typeof v === "string" && v.length > 0) out.push(v);
  }
  return out;
}

/**
 * Widen a relative-looking directory glob so it matches regardless of
 * where in an absolute path it appears. Without this, a natural
 * `forbiddenPaths` entry like `"secrets/**"` (written the way an operator
 * would expect — "block anything under a secrets directory") never
 * matches the absolute paths most resolved tool calls actually carry
 * (e.g. `/home/user/project/secrets/keys.pem`) — `minimatch` anchors a
 * non-`**`-prefixed, non-absolute pattern to the START of the string.
 * Leaves already-absolute (`/...`) or already-`**`-anchored patterns
 * untouched — those are deliberately anchored by the operator.
 */
function widenRelativeGlob(g: string): string | null {
  if (g.startsWith("/") || g.startsWith("**/") || g.startsWith("**")) {
    return null;
  }
  return `**/${g}`;
}

function matchesAnyGlob(candidate: string, globs: string[]): string | null {
  // Match both the raw (possibly relative) value and its normalized form,
  // since a forbidden-path glob author can't predict whether a tool
  // receives an absolute or workspace-relative path.
  const normalized = candidate.replace(/\\/g, "/");
  const basename = path.basename(normalized);
  // Security boundary: match case-INsensitively unconditionally, not just
  // on case-insensitive filesystems. macOS and Windows (both explicitly
  // supported — see CLAUDE.md) default to case-insensitive filesystems,
  // where `SECRETS.env` and `secrets.env` resolve to the SAME file — a
  // case-varied path must not bypass a forbiddenPaths block. On Linux
  // (case-sensitive) this only widens matches (never narrows), which for
  // a deny-list is the safe direction to err in.
  const opts = { dot: true, nocase: true } as const;
  for (const g of globs) {
    if (minimatch(normalized, g, opts) || minimatch(basename, g, opts)) {
      return g;
    }
    const widened = widenRelativeGlob(g);
    if (widened && minimatch(normalized, widened, opts)) {
      return g;
    }
  }
  return null;
}

function extractUrlCandidates(
  toolName: string,
  params: Record<string, unknown>,
): string[] {
  const isNetworkTool =
    toolName === "sendHttpRequest" || toolName.startsWith("http.");
  if (!isNetworkTool) return [];
  const v = params.url;
  return typeof v === "string" && v.length > 0 ? [v] : [];
}

function hostAllowed(url: string, allowedHosts: string[]): boolean {
  if (allowedHosts.length === 0) return true; // no restriction configured
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false; // unparsable URL — fail closed
  }
  return allowedHosts.some((pattern) => minimatch(hostname, pattern));
}

function extractCommandCandidate(
  toolName: string,
  params: Record<string, unknown>,
): string | null {
  const isCommandTool =
    toolName === "runCommand" ||
    toolName === "runInTerminal" ||
    toolName === "sendTerminalCommand";
  if (!isCommandTool) return null;
  const v = params.command;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Deterministic policy check for a single tool call. Pure function — no
 * I/O, no LLM, same inputs always produce the same output. Called from
 * `evaluateInProcessGate` before the trust/approval gate runs.
 */
export function checkPolicy(
  policy: PatchworkPolicy,
  opts: {
    toolName: string;
    params: Record<string, unknown>;
    workerId?: string;
  },
): PolicyCheckResult {
  const { toolName, params, workerId } = opts;

  // 1. Forbidden paths — applies to every tool/worker, no override.
  for (const candidate of extractPathCandidates(params)) {
    const hit = matchesAnyGlob(candidate, policy.defaults.forbiddenPaths);
    if (hit) {
      return {
        allowed: false,
        reason: `path "${candidate}" matches forbidden pattern "${hit}"`,
      };
    }
  }

  // 2. Network host allowlist.
  for (const url of extractUrlCandidates(toolName, params)) {
    if (!hostAllowed(url, policy.defaults.allowedNetworkHosts)) {
      return {
        allowed: false,
        reason: `network request to "${url}" is not in allowedNetworkHosts`,
      };
    }
  }

  // 3. Command allowlist.
  const command = extractCommandCandidate(toolName, params);
  if (command && policy.defaults.allowedCommands.length > 0) {
    const permitted = policy.defaults.allowedCommands.some((pattern) =>
      minimatch(command, pattern),
    );
    if (!permitted) {
      return {
        allowed: false,
        reason: `command "${command}" is not in allowedCommands`,
      };
    }
  }

  // 4. Per-worker tool allowlist — only applies when the worker has an
  // explicit allowedTools list; absent worker entry or absent field means
  // no additional restriction beyond the defaults already checked above.
  if (workerId) {
    const workerPolicy = policy.workers[workerId];
    if (
      workerPolicy?.allowedTools &&
      !workerPolicy.allowedTools.includes(toolName)
    ) {
      return {
        allowed: false,
        reason: `worker "${workerId}" is not allowed to call "${toolName}" (not in its allowedTools list)`,
      };
    }
  }

  return { allowed: true };
}
