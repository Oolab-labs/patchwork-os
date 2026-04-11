import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProbeResults } from "../probe.js";
import {
  execSafe,
  optionalString,
  successStructuredLarge,
  withHeartbeat,
} from "./utils.js";

const CACHE_TTL = 60_000;

type Severity = "info" | "low" | "moderate" | "high" | "critical";

interface Advisory {
  id: string;
  package: string;
  severity: Severity;
  title: string;
  fix?: string;
  url?: string;
}

interface AuditResult {
  packageManager: string;
  totalVulnerabilities: number;
  bySeverity: Partial<Record<Severity, number>>;
  advisories: Advisory[];
}

interface CacheEntry {
  data: AuditResult;
  timestamp: number;
}

const SEVERITY_ORDER: Severity[] = [
  "info",
  "low",
  "moderate",
  "high",
  "critical",
];

function severityGte(a: Severity, threshold: Severity): boolean {
  return SEVERITY_ORDER.indexOf(a) >= SEVERITY_ORDER.indexOf(threshold);
}

// Shared parser for npm/pnpm audit JSON (both use the same v7 format).
function parseNpmAuditJson(raw: string, packageManager: string): AuditResult {
  const parsed = JSON.parse(raw) as {
    vulnerabilities?: Record<
      string,
      {
        severity: string;
        via: Array<{ title?: string; url?: string; range?: string } | string>;
        fixAvailable?: boolean | { name: string; version: string };
      }
    >;
    metadata?: { vulnerabilities: Record<string, number> };
  };

  const advisories: Advisory[] = [];
  for (const [pkg, vuln] of Object.entries(parsed.vulnerabilities ?? {})) {
    const sev = (vuln.severity ?? "info") as Severity;
    const viaEntry = vuln.via[0];
    const title =
      typeof viaEntry === "object" && viaEntry.title
        ? viaEntry.title
        : `Vulnerability in ${pkg}`;
    const url =
      typeof viaEntry === "object" && viaEntry.url ? viaEntry.url : undefined;
    let fix: string | undefined;
    if (typeof vuln.fixAvailable === "object" && vuln.fixAvailable) {
      fix = `upgrade to ${vuln.fixAvailable.name}@${vuln.fixAvailable.version}`;
    } else if (vuln.fixAvailable === true) {
      fix = `run ${packageManager} audit fix`;
    }
    advisories.push({ id: pkg, package: pkg, severity: sev, title, fix, url });
  }

  // Include all severity levels with zero-counts so callers can always check
  // bySeverity["low"] without a key-existence guard.
  const bySeverity: Record<Severity, number> = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  };
  for (const adv of advisories) {
    bySeverity[adv.severity]++;
  }

  return {
    packageManager,
    totalVulnerabilities: advisories.length,
    bySeverity,
    advisories,
  };
}

async function runNpmAudit(
  workspace: string,
  signal?: AbortSignal,
): Promise<AuditResult> {
  const result = await execSafe("npm", ["audit", "--json"], {
    cwd: workspace,
    signal,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });

  // npm audit exits non-zero when there are vulnerabilities — that's expected
  const raw = result.stdout.trim();
  if (!raw) {
    throw new Error(result.stderr.trim() || "npm audit returned no output");
  }
  return parseNpmAuditJson(raw, "npm");
}

async function runPnpmAudit(
  workspace: string,
  signal?: AbortSignal,
): Promise<AuditResult> {
  const result = await execSafe("pnpm", ["audit", "--json"], {
    cwd: workspace,
    signal,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });

  // pnpm audit exits non-zero when vulnerabilities found — that's expected.
  // Check for binary-not-found before attempting to parse.
  const errText = result.stderr.trim();
  if (
    errText &&
    (errText.includes("ENOENT") || errText.includes("not found")) &&
    !result.stdout.trim()
  ) {
    throw new Error(errText);
  }
  const raw = result.stdout.trim();
  if (!raw) throw new Error("pnpm audit returned no output");
  return parseNpmAuditJson(raw, "pnpm");
}

async function runYarnAudit(
  workspace: string,
  signal?: AbortSignal,
): Promise<AuditResult> {
  const result = await execSafe("yarn", ["audit", "--json"], {
    cwd: workspace,
    signal,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });

  // yarn audit --json emits one JSON object per line (JSONL).
  // "auditAdvisory" events carry individual vulnerability data.
  // yarn exits non-zero when vulnerabilities found — that's expected.
  const errText = result.stderr.trim();
  if (
    errText &&
    (errText.includes("ENOENT") || errText.includes("not found")) &&
    !result.stdout.trim()
  ) {
    throw new Error(errText);
  }

  // Guard against non-ENOENT failures (network error, registry unreachable, etc.)
  // that leave stdout empty. Without this guard, the JSONL loop below silently
  // returns zero advisories — a false-clean result on a failed audit.
  const raw = result.stdout.trim();
  if (!raw) throw new Error(errText || "yarn audit returned no output");

  const output = `${result.stdout}\n${result.stderr}`.trim();
  const advisories: Advisory[] = [];

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      typeof obj === "object" &&
      obj !== null &&
      (obj as Record<string, unknown>).type === "auditAdvisory"
    ) {
      const adv = (
        obj as {
          data: {
            advisory: {
              id: number;
              module_name: string;
              severity: string;
              title: string;
              url?: string;
              patched_versions?: string;
            };
          };
        }
      ).data.advisory;
      const sev = (adv.severity ?? "info") as Severity;
      const fix =
        adv.patched_versions && adv.patched_versions !== "<0.0.0"
          ? `upgrade to ${adv.patched_versions}`
          : undefined;
      advisories.push({
        id: String(adv.id),
        package: adv.module_name,
        severity: sev,
        title: adv.title,
        fix,
        url: adv.url,
      });
    }
  }

  // Include all severity levels with zero-counts so callers can always check
  // bySeverity["low"] without a key-existence guard.
  const bySeverity: Record<Severity, number> = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  };
  for (const adv of advisories) {
    bySeverity[adv.severity]++;
  }

  return {
    packageManager: "yarn",
    totalVulnerabilities: advisories.length,
    bySeverity,
    advisories,
  };
}

async function runCargoAudit(
  workspace: string,
  signal?: AbortSignal,
): Promise<AuditResult> {
  const result = await execSafe("cargo", ["audit", "--json"], {
    cwd: workspace,
    signal,
    timeout: 60_000,
  });

  // cargo audit exits non-zero when vulnerabilities found.
  // Propagate stderr so the ENOENT handler in the caller fires correctly.
  const errText = result.stderr.trim();
  if (
    errText &&
    (errText.includes("ENOENT") || errText.includes("not found")) &&
    !result.stdout.trim()
  ) {
    throw new Error(errText);
  }
  const raw = result.stdout.trim();
  if (!raw) throw new Error("cargo audit returned no output");

  const parsed = JSON.parse(raw) as {
    vulnerabilities?: {
      list: Array<{
        advisory: { id: string; title: string; url?: string; cvss?: string };
        package: { name: string };
        versions: { patched: string[] };
      }>;
    };
  };

  const advisories: Advisory[] = (parsed.vulnerabilities?.list ?? []).map(
    (v) => ({
      id: v.advisory.id,
      package: v.package.name,
      severity: "high" as Severity, // cargo audit doesn't always include CVSS level
      title: v.advisory.title,
      fix:
        v.versions.patched.length > 0
          ? `patch: ${v.versions.patched.join(", ")}`
          : undefined,
      url: v.advisory.url,
    }),
  );

  // Include all severity levels with zero-counts so callers can always check
  // bySeverity["low"] without a key-existence guard.
  const bySeverity: Record<Severity, number> = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  };
  for (const adv of advisories) {
    bySeverity[adv.severity]++;
  }

  return {
    packageManager: "cargo",
    totalVulnerabilities: advisories.length,
    bySeverity,
    advisories,
  };
}

async function runPipAudit(
  workspace: string,
  signal?: AbortSignal,
): Promise<AuditResult> {
  const result = await execSafe(
    "pip-audit",
    ["--format=json", "--progress-spinner=off"],
    {
      cwd: workspace,
      signal,
      timeout: 60_000,
    },
  );

  // Propagate stderr so the ENOENT handler in the caller fires correctly.
  const errText = result.stderr.trim();
  if (
    errText &&
    (errText.includes("ENOENT") || errText.includes("not found")) &&
    !result.stdout.trim()
  ) {
    throw new Error(errText);
  }
  const raw = result.stdout.trim();
  if (!raw) throw new Error("pip-audit returned no output");

  const parsed = JSON.parse(raw) as {
    dependencies: Array<{
      name: string;
      version: string;
      vulns: Array<{ id: string; description: string; fix_versions: string[] }>;
    }>;
  };

  const advisories: Advisory[] = [];
  for (const dep of parsed.dependencies) {
    for (const v of dep.vulns) {
      advisories.push({
        id: v.id,
        package: dep.name,
        severity: "high" as Severity,
        title: v.description.slice(0, 120),
        fix:
          v.fix_versions.length > 0
            ? `upgrade to ${v.fix_versions.join(" or ")}`
            : undefined,
      });
    }
  }

  // Include all severity levels with zero-counts so callers can always check
  // bySeverity["low"] without a key-existence guard.
  const bySeverity: Record<Severity, number> = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  };
  for (const adv of advisories) {
    bySeverity[adv.severity]++;
  }

  return {
    packageManager: "pip",
    totalVulnerabilities: advisories.length,
    bySeverity,
    advisories,
  };
}

function detectAuditor(workspace: string, hint?: string): string | null {
  if (hint && hint !== "auto") return hint;
  // Check lock files before package.json — pnpm/yarn projects always have package.json too
  if (existsSync(join(workspace, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(workspace, "yarn.lock"))) return "yarn";
  if (existsSync(join(workspace, "package.json"))) return "npm";
  if (existsSync(join(workspace, "Cargo.toml"))) return "cargo";
  if (
    existsSync(join(workspace, "requirements.txt")) ||
    existsSync(join(workspace, "pyproject.toml"))
  )
    return "pip";
  return null;
}

export function createGetSecurityAdvisoriesTool(
  workspace: string,
  _probes?: ProbeResults,
) {
  const cache = new Map<string, CacheEntry>();

  return {
    schema: {
      name: "getSecurityAdvisories",
      description:
        "Run a security audit and return known vulnerabilities with severity, CVE IDs, and remediation steps. " +
        "Auto-detects npm/yarn/pnpm, cargo, or pip-audit from lock files.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          packageManager: {
            type: "string",
            enum: ["auto", "npm", "yarn", "pnpm", "cargo", "pip"],
            description: "Package manager to audit. Default: auto-detect",
          },
          severity: {
            type: "string",
            enum: ["low", "moderate", "high", "critical", "all"],
            description: "Minimum severity to include in results. Default: all",
          },
          onlyFixable: {
            type: "boolean",
            description:
              "Only return advisories that have a known fix available",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          available: { type: "boolean" },
          packageManager: { type: "string" },
          totalVulnerabilities: { type: "integer" },
          bySeverity: {
            type: "object",
            properties: {
              info: { type: "integer" },
              low: { type: "integer" },
              moderate: { type: "integer" },
              high: { type: "integer" },
              critical: { type: "integer" },
            },
          },
          advisories: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                package: { type: "string" },
                severity: {
                  type: "string",
                  enum: ["info", "low", "moderate", "high", "critical"],
                },
                title: { type: "string" },
                fix: { type: "string" },
                url: { type: "string" },
              },
              required: ["id", "package", "severity", "title"],
            },
          },
          error: { type: "string" },
        },
        required: ["available"],
      },
    },
    timeoutMs: 65_000,

    async handler(
      args: Record<string, unknown>,
      signal?: AbortSignal,
      progress?: (value: number, total: number, message?: string) => void,
    ) {
      const pm = optionalString(args, "packageManager") ?? "auto";
      const minSeverity = (optionalString(args, "severity") ?? "all") as
        | Severity
        | "all";
      const onlyFixable = args.onlyFixable === true;

      // Resolve "auto" to the actual package manager before computing the cache
      // key so that `pm="auto"` and `pm="npm"` share the same cache entry on an
      // npm workspace (same fix applied to auditDependencies.ts in v2.1.14).
      const detected = detectAuditor(workspace, pm);
      if (!detected) {
        return successStructuredLarge({
          available: false,
          packageManager: null,
          error:
            "No supported package manifest found (pnpm-lock.yaml, yarn.lock, package.json, Cargo.toml, requirements.txt, pyproject.toml)",
        });
      }

      // Cache key uses the resolved manager name (not the raw `pm` input) so
      // that "auto" and explicit calls (e.g. "npm") share the same cache entry.
      // We always cache the full (all-severity) result and filter at presentation
      // time — this prevents redundant audit runs for different severity thresholds.
      const cacheKey = detected;
      const now = Date.now();
      const cached = cache.get(cacheKey);
      if (cached && now - cached.timestamp < CACHE_TTL) {
        const result = applyFilters(cached.data, minSeverity, onlyFixable);
        return successStructuredLarge({ available: true, ...result });
      }

      try {
        let result: AuditResult;
        switch (detected) {
          case "npm":
            result = await withHeartbeat(
              () => runNpmAudit(workspace, signal),
              progress,
              { message: "running npm audit…" },
            );
            break;
          case "yarn":
            result = await withHeartbeat(
              () => runYarnAudit(workspace, signal),
              progress,
              { message: "running yarn audit…" },
            );
            break;
          case "pnpm":
            result = await withHeartbeat(
              () => runPnpmAudit(workspace, signal),
              progress,
              { message: "running pnpm audit…" },
            );
            break;
          case "cargo":
            result = await withHeartbeat(
              () => runCargoAudit(workspace, signal),
              progress,
              { message: "running cargo audit…" },
            );
            break;
          case "pip":
            result = await withHeartbeat(
              () => runPipAudit(workspace, signal),
              progress,
              { message: "running pip-audit…" },
            );
            break;
          default:
            return successStructuredLarge({
              available: false,
              packageManager: detected,
              error: `Unsupported auditor: ${detected}`,
            });
        }

        cache.set(cacheKey, { data: result, timestamp: Date.now() });
        const filtered = applyFilters(result, minSeverity, onlyFixable);
        return successStructuredLarge({ available: true, ...filtered });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // Cap error messages to the first line to avoid leaking internal paths,
        // proxy configs, or env vars that may appear in multi-line stderr output.
        const safeMsg = msg.split("\n")[0]?.trim() ?? msg;
        // If binary not found, give actionable message
        if (msg.includes("ENOENT") || msg.includes("not found")) {
          const tool =
            detected === "npm"
              ? "npm"
              : detected === "yarn"
                ? "yarn"
                : detected === "pnpm"
                  ? "pnpm"
                  : detected === "cargo"
                    ? "cargo-audit (install: cargo install cargo-audit)"
                    : "pip-audit (install: pip install pip-audit)";
          return successStructuredLarge({
            available: false,
            packageManager: detected,
            error: `${tool} not found. ${safeMsg}`,
          });
        }
        return successStructuredLarge({
          available: false,
          packageManager: detected,
          error: safeMsg,
        });
      }
    },
  };
}

function filterBySeverity(
  result: AuditResult,
  minSeverity: Severity | "all",
): AuditResult {
  if (minSeverity === "all") return result;
  const advisories = result.advisories.filter((a) =>
    severityGte(a.severity, minSeverity),
  );
  // Include all severity levels with zero-counts so callers can always check
  // bySeverity["low"] without a key-existence guard.
  const bySeverity: Record<Severity, number> = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  };
  for (const adv of advisories) {
    bySeverity[adv.severity]++;
  }
  return {
    ...result,
    totalVulnerabilities: advisories.length,
    bySeverity,
    advisories,
  };
}

function applyFilters(
  result: AuditResult,
  minSeverity: Severity | "all",
  onlyFixable: boolean,
): AuditResult {
  const afterSeverity = filterBySeverity(result, minSeverity);
  if (!onlyFixable) return afterSeverity;
  const advisories = afterSeverity.advisories.filter(
    (a) => a.fix !== undefined,
  );
  const bySeverity: Record<Severity, number> = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  };
  for (const adv of advisories) {
    bySeverity[adv.severity]++;
  }
  return {
    ...afterSeverity,
    totalVulnerabilities: advisories.length,
    bySeverity,
    advisories,
  };
}
