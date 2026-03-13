import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProbeResults } from "../probe.js";
import { execSafe, optionalString, success } from "./utils.js";

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
      fix = "run npm audit fix";
    }
    advisories.push({ id: pkg, package: pkg, severity: sev, title, fix, url });
  }

  const bySeverity: Partial<Record<Severity, number>> = {};
  for (const adv of advisories) {
    bySeverity[adv.severity] = (bySeverity[adv.severity] ?? 0) + 1;
  }

  return {
    packageManager: "npm",
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

  // cargo audit exits non-zero when vulnerabilities found
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

  const bySeverity: Partial<Record<Severity, number>> = {};
  for (const adv of advisories) {
    bySeverity[adv.severity] = (bySeverity[adv.severity] ?? 0) + 1;
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

  const bySeverity: Partial<Record<Severity, number>> = {};
  for (const adv of advisories) {
    bySeverity[adv.severity] = (bySeverity[adv.severity] ?? 0) + 1;
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
        "Run a security audit and return known vulnerabilities with severity, CVE IDs, and remediation steps. Auto-detects npm audit, cargo audit, or pip-audit from manifest files. Essential before merging PRs or deploying.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          packageManager: {
            type: "string",
            enum: ["npm", "pip", "cargo", "auto"],
            description: "Package manager to audit. Default: auto-detect",
          },
          severity: {
            type: "string",
            enum: ["low", "moderate", "high", "critical", "all"],
            description: "Minimum severity to include in results. Default: all",
          },
        },
        additionalProperties: false as const,
      },
    },
    timeoutMs: 65_000,

    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const pm = optionalString(args, "packageManager") ?? "auto";
      const minSeverity = (optionalString(args, "severity") ?? "all") as
        | Severity
        | "all";

      const cacheKey = `${pm}:${minSeverity}`;
      const now = Date.now();
      const cached = cache.get(cacheKey);
      if (cached && now - cached.timestamp < CACHE_TTL) {
        const result = filterBySeverity(cached.data, minSeverity);
        return success({ available: true, ...result });
      }

      const detected = detectAuditor(workspace, pm);
      if (!detected) {
        return success({
          available: false,
          packageManager: null,
          error:
            "No supported package manifest found (package.json, Cargo.toml, requirements.txt)",
        });
      }

      try {
        let result: AuditResult;
        switch (detected) {
          case "npm":
            result = await runNpmAudit(workspace, signal);
            break;
          case "cargo":
            result = await runCargoAudit(workspace, signal);
            break;
          case "pip":
            result = await runPipAudit(workspace, signal);
            break;
          default:
            return success({
              available: false,
              packageManager: detected,
              error: `Unsupported auditor: ${detected}`,
            });
        }

        cache.set(cacheKey, { data: result, timestamp: Date.now() });
        const filtered = filterBySeverity(result, minSeverity);
        return success({ available: true, ...filtered });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // If binary not found, give actionable message
        if (msg.includes("ENOENT") || msg.includes("not found")) {
          const tool =
            detected === "npm"
              ? "npm"
              : detected === "cargo"
                ? "cargo-audit (install: cargo install cargo-audit)"
                : "pip-audit (install: pip install pip-audit)";
          return success({
            available: false,
            packageManager: detected,
            error: `${tool} not found. ${msg}`,
          });
        }
        return success({
          available: false,
          packageManager: detected,
          error: msg,
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
  const bySeverity: Partial<Record<Severity, number>> = {};
  for (const adv of advisories) {
    bySeverity[adv.severity] = (bySeverity[adv.severity] ?? 0) + 1;
  }
  return {
    ...result,
    totalVulnerabilities: advisories.length,
    bySeverity,
    advisories,
  };
}
