/**
 * Orchestrator dispatch is OBSERVED in the privacy shadow ledger (#1397).
 *
 * Drives the REAL `ClaudeOrchestrator` rather than calling the observer
 * directly. A hand-injected observer proves the logic and never the path, and
 * the path is the entire question here: this file exists because #1397 is
 * about a dispatch route that bypasses the boundary, and a test that does not
 * go through `enqueue` cannot tell whether the call site is wired at all.
 *
 * `PATCHWORK_HOME` is redirected rather than spying on a module: a namespace
 * spy does not reach a named import, and the failure mode is that the test
 * quietly writes to the operator's real `~/.patchwork`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClaudeOrchestrator } from "../../claudeOrchestrator.js";
import type { ProviderDriver } from "../../drivers/types.js";

let dir: string;
let prevHome: string | undefined;

function driver(): ProviderDriver {
  return {
    name: "anthropic",
    run: async () => ({ text: "ok", exitCode: 0 }),
  } as unknown as ProviderDriver;
}

/** Candidate policy clearing only `public` to a remote — so the default is a crossing. */
function writeShadowConfig(): void {
  writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({
      privacy: {
        shadow: {
          destinations: {
            "candidate-remote": {
              type: "remote",
              classifications: ["public"],
              drivers: ["anthropic"],
            },
          },
        },
      },
    }),
  );
}

function rows(): Array<Record<string, unknown>> {
  try {
    return (
      readFileSync(path.join(dir, "privacy_shadow.jsonl"), "utf-8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        // ADR-0027 marker rows (`chain-start`, `rotation`) share the file; skip them like every production loader.
        .filter((r) => r.kind !== "chain-start" && r.kind !== "rotation")
    );
  } catch {
    return [];
  }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "orch-shadow-"));
  prevHome = process.env.PATCHWORK_HOME;
  process.env.PATCHWORK_HOME = dir;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.PATCHWORK_HOME;
  else process.env.PATCHWORK_HOME = prevHome;
  rmSync(dir, { recursive: true, force: true });
});

describe("orchestrator dispatch is observed, never enforced (#1397)", () => {
  it("records a row through the real enqueue path", async () => {
    writeShadowConfig();
    const orch = new ClaudeOrchestrator(driver(), dir, () => {});
    const id = orch.enqueue({ prompt: "synthetic prompt" });
    await new Promise((r) => setImmediate(r));

    // The dispatch SUCCEEDED. Observation must not gate anything — if this
    // ever reads "error", the observer has become an enforcer.
    expect(orch.getTask(id)?.status).toBe("done");

    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0]?.path).toBe("orchestrator-task");
    // Never "declared": this path has no declared-policy channel, and saying
    // otherwise asserts operator intent nobody expressed — the exact reason
    // ADR-0021 kept it out of scope.
    expect(r[0]?.labelSource).toBe("assumed");
    expect(r[0]?.enforcing).toBe(false);
    // It genuinely disagreed, or the assertions above pass for the wrong
    // reason on a policy that happened to allow everything.
    expect(r[0]?.decision).not.toBe("ALLOW");
  });

  it("writes nothing when no candidate policy is configured", async () => {
    // No config.json at all. Shadow is opt-in; an unconfigured install must
    // not start accumulating a privacy ledger it never asked for.
    const orch = new ClaudeOrchestrator(driver(), dir, () => {});
    orch.enqueue({ prompt: "synthetic prompt" });
    await new Promise((r) => setImmediate(r));
    expect(rows()).toHaveLength(0);
  });

  it("carries no payload — the prompt is never written", async () => {
    writeShadowConfig();
    const orch = new ClaudeOrchestrator(driver(), dir, () => {});
    orch.enqueue({ prompt: "SENTINEL-PROMPT-TEXT" });
    await new Promise((r) => setImmediate(r));

    const raw = readFileSync(path.join(dir, "privacy_shadow.jsonl"), "utf-8");
    // An orchestrator prompt is free-form and frequently assembled from
    // workspace context, so it is the LEAST safe thing in the system to copy
    // into an audit log.
    expect(raw).not.toContain("SENTINEL-PROMPT-TEXT");
  });
});
