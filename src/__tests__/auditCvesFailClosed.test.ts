/**
 * `scripts/audit-production-cves.mjs` — must fail CLOSED when it cannot audit.
 *
 * This gate reported a clean supply chain on every registry outage. npm emits
 * well-formed JSON when it cannot reach the registry:
 *
 *     { "message": "request to …/security/advisories/bulk failed, reason:
 *                   connect ECONNREFUSED …",
 *       "error": { "summary": "", "detail": "" } }
 *
 * `JSON.parse` succeeded, `report.vulnerabilities ?? {}` yielded `{}`, the
 * findings loop ran zero times, and it printed
 *
 *     [prod-cves] 4 workspace(s) audited (production deps only): …
 *     [prod-cves] OK — no high or critical production advisories.
 *
 * exit 0 — byte-identical to a clean run. The script's own header asserted
 * that unparseable stdout was the guard; the failure output parses fine, so
 * the premise was false.
 *
 * These tests do NOT hit the network. Hanging a CI job on a real registry, or
 * having the suite go red because npmjs had a bad minute, would be a worse
 * gate than the one being fixed. They drive the shape check directly with the
 * two payloads npm actually produces — captured from real runs, not invented.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SCRIPT = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "scripts",
  "audit-production-cves.mjs",
);

/**
 * The predicate the script uses, mirrored.
 *
 * Kept in step with the real file by the source assertions below: if the
 * script's condition changes shape, those fail and this mirror must be
 * revisited. Mirroring is the trade for not spawning four `npm audit` calls
 * per test run.
 */
function looksLikeAuditReport(report: unknown): boolean {
  const r = report as {
    auditReportVersion?: unknown;
    metadata?: { vulnerabilities?: unknown };
  } | null;
  return (
    r !== null &&
    typeof r === "object" &&
    r.auditReportVersion !== undefined &&
    typeof r.metadata?.vulnerabilities === "object"
  );
}

/** Captured verbatim from `npm audit --json` against an unreachable registry. */
const REGISTRY_FAILURE = {
  message:
    "request to http://127.0.0.1:9/-/npm/v1/security/advisories/bulk failed, reason: connect ECONNREFUSED 127.0.0.1:9",
  error: { summary: "", detail: "" },
};

/** Captured verbatim from a successful `npm audit --json` in this repo. */
const CLEAN_REPORT = {
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
  },
};

describe("a registry failure must not read as a clean audit", () => {
  it("rejects npm's error envelope", () => {
    // The exact payload that produced "OK — no high or critical production
    // advisories" for every workspace.
    expect(looksLikeAuditReport(REGISTRY_FAILURE)).toBe(false);
  });

  it("accepts a real audit report (control)", () => {
    // Without this, the assertion above holds just as well for a predicate
    // that rejects everything — which would fail CI permanently.
    expect(looksLikeAuditReport(CLEAN_REPORT)).toBe(true);
  });

  it("rejects a report missing metadata.vulnerabilities", () => {
    // Partial shapes must not squeak through: `vulnerabilities: {}` alone is
    // exactly what the error path degrades to.
    expect(
      looksLikeAuditReport({ auditReportVersion: 2, vulnerabilities: {} }),
    ).toBe(false);
  });

  it("rejects null and non-objects", () => {
    for (const bad of [null, undefined, 42, "ok", []]) {
      expect(looksLikeAuditReport(bad)).toBe(false);
    }
  });
});

describe("the script still enforces this", () => {
  const src = readFileSync(SCRIPT, "utf8");

  it("checks auditReportVersion AND metadata.vulnerabilities", () => {
    // Pins the mirror above to the real implementation. If someone loosens the
    // condition, this fails and the mirror stops being a lie.
    expect(src).toContain("auditReportVersion");
    expect(src).toContain("metadata?.vulnerabilities");
  });

  it("exits 2, not 1, when it could not audit", () => {
    // "We could not audit" is a different fact from "we audited and found
    // nothing", and the two must never print the same thing. Exit 2 is this
    // repo's script/config-error code.
    const idx = src.indexOf("did NOT return an audit report");
    expect(idx).toBeGreaterThan(-1);
    expect(src.slice(idx, idx + 600)).toContain("process.exit(2)");
  });
});

describe("the real script exits 2 on a registry failure", () => {
  // POSIX-only: the seam is a fake `npm` earlier on PATH, and a `#!/bin/sh`
  // stub is not executable on Windows. Same convention as the symlink tests in
  // src/recipes/tools/__tests__/file.test.ts.
  //
  // This test exists because the source-string assertions above CANNOT detect
  // the guard being disabled — mutating its condition to `if (false)` left
  // every one of them green. Only driving the script proves the branch is
  // live, which is the whole lesson of this session applied to its own fix.
  it.skipIf(process.platform === "win32")(
    "fails closed when npm cannot reach the registry",
    () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "cve-gate-"));
      try {
        const bin = path.join(dir, "bin");
        execFileSync("mkdir", ["-p", bin]);
        const stub = path.join(bin, "npm");
        // Emits npm's real registry-failure envelope on stdout and exits 1,
        // exactly as npm does.
        writeFileSync(
          stub,
          `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(REGISTRY_FAILURE)}\nJSON\nexit 1\n`,
        );
        chmodSync(stub, 0o755);

        let status = 0;
        let out = "";
        try {
          out = execFileSync(process.execPath, [SCRIPT], {
            cwd: path.resolve(import.meta.dirname, "..", ".."),
            encoding: "utf8",
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
          });
        } catch (err) {
          const e = err as {
            status?: number;
            stdout?: string;
            stderr?: string;
          };
          status = e.status ?? -1;
          out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
        }

        expect(status).toBe(2);
        expect(out).toContain("nothing was checked");
        // The exact string it must NEVER print in this state.
        expect(out).not.toContain("no high or critical production advisories");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
