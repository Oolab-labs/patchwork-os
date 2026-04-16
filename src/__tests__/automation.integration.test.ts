/**
 * Automation hook integration tests — exercises the full path from
 * handler call → placeholder substitution → task enqueued, plus the
 * real HTTP /notify route for onPostCompact.
 *
 * Uses a real Server instance (same pattern as integration.test.ts) with
 * makeInstantOrchestrator() + AutomationHooks wired directly.
 * No subprocess spawning — the driver is an in-memory instant mock.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Diagnostic } from "../automation.js";
import { AutomationHooks } from "../automation.js";
import type { IClaudeDriver } from "../claudeDriver.js";
import { ClaudeOrchestrator } from "../claudeOrchestrator.js";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeInstantOrchestrator() {
  const driver: IClaudeDriver = {
    name: "instant",
    async run() {
      return { text: "ok", exitCode: 0, durationMs: 1 };
    },
  };
  return new ClaudeOrchestrator(driver, "/tmp", () => {});
}

function makePolicy(hook: string, prompt: string) {
  return { [hook]: { enabled: true, prompt, cooldownMs: 0 } };
}

const servers: Server[] = [];

async function setupWithAutomation(policy: Record<string, unknown>) {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "bridge-automation-integ-"),
  );
  const authToken = randomUUID();
  const logger = new Logger(false);
  const server = new Server(authToken, logger);
  const orch = makeInstantOrchestrator();
  const hooks = new AutomationHooks(
    policy as Parameters<typeof AutomationHooks>[0],
    orch,
    () => {},
    undefined,
    workspace,
  );

  // Wire the /notify endpoint the same way bridge.ts does (~line 828)
  server.notifyFn = (event, _args) => {
    switch (event) {
      case "PostCompact":
        hooks.handlePostCompact();
        return { ok: true };
      case "InstructionsLoaded":
        hooks.handleInstructionsLoaded();
        return { ok: true };
      default:
        return { ok: false, error: `Unknown event: ${event}` };
    }
  };

  const port = await server.findAndListen(null);
  servers.push(server);
  return { hooks, orch, server, port, authToken };
}

afterAll(() => {
  for (const s of servers) s.close();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("automation hook integration — placeholder substitution", () => {
  it("onDiagnosticsError: {{file}} and {{diagnostics}} are substituted", async () => {
    const { hooks, orch } = await setupWithAutomation(
      makePolicy("onDiagnosticsError", "error in {{file}}: {{diagnostics}}"),
    );

    const diags: Diagnostic[] = [
      { message: "Type mismatch", severity: "error", source: "ts" },
    ];
    hooks.handleDiagnosticsChanged("/src/foo.ts", diags);

    // allow instant driver to settle
    await new Promise((r) => setTimeout(r, 20));

    const tasks = orch.list();
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.prompt).toContain("/src/foo.ts");
    expect(tasks[0]!.prompt).toContain("Type mismatch");
  });

  it("onFileSave: {{file}} is substituted with the saved file path", async () => {
    const { hooks, orch, server } = await setupWithAutomation({
      onFileSave: {
        enabled: true,
        patterns: ["**/*.ts"],
        prompt: "saved: {{file}}",
        cooldownMs: 0,
      },
    });
    // Get the workspace from the server's workspace property via the hooks workspace
    // Use a path that will match **/*.ts (absolute path works via minimatch fallback)
    const filePath = "/tmp/src/bar.ts";
    hooks.handleFileSaved("id1", "save", filePath);

    await new Promise((r) => setTimeout(r, 20));

    const tasks = orch.list();
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.prompt).toContain("bar.ts");
  });

  it("onGitCommit: {{hash}}, {{branch}}, {{files}} are substituted", async () => {
    const { hooks, orch } = await setupWithAutomation(
      makePolicy(
        "onGitCommit",
        "commit {{hash}} on {{branch}} changed {{files}}",
      ),
    );

    hooks.handleGitCommit({
      hash: "abc1234",
      branch: "main",
      message: "feat: add widget",
      count: 2,
      files: ["src/a.ts", "src/b.ts"],
    });

    await new Promise((r) => setTimeout(r, 20));

    const tasks = orch.list();
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.prompt).toContain("abc1234");
    expect(tasks[0]!.prompt).toContain("main");
    expect(tasks[0]!.prompt).toContain("src/a.ts");
  });

  it("onTestRun: {{failed}}, {{passed}}, {{total}} are substituted", async () => {
    const { hooks, orch } = await setupWithAutomation(
      makePolicy(
        "onTestRun",
        "{{failed}} failed / {{passed}} passed / {{total}} total",
      ),
    );

    hooks.handleTestRun({
      runners: ["vitest"],
      summary: { failed: 2, passed: 10, total: 12, skipped: 0, errored: 0 },
      failures: [],
    });

    await hooks.flush();

    const tasks = orch.list();
    expect(tasks.length).toBe(1);
    // Values are nonce-wrapped in untrustedBlock — check raw values are present
    expect(tasks[0]!.prompt).toContain("2");
    expect(tasks[0]!.prompt).toContain("10");
    expect(tasks[0]!.prompt).toContain("12");
    expect(tasks[0]!.prompt).toContain("FAILED");
    expect(tasks[0]!.prompt).toContain("PASSED");
    expect(tasks[0]!.prompt).toContain("TOTAL");
  });
});

describe("automation hook integration — /notify HTTP route", () => {
  it("POST /notify with PostCompact triggers onPostCompact task", async () => {
    const { orch, port, authToken } = await setupWithAutomation(
      makePolicy("onPostCompact", "context was compacted"),
    );

    await new Promise<void>((resolve, reject) => {
      const body = JSON.stringify({ event: "PostCompact", args: {} });
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/notify",
          method: "POST",
          headers: {
            Authorization: `Bearer ${authToken}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (c: Buffer) => {
            data += c.toString();
          });
          res.on("end", () => {
            try {
              expect(res.statusCode).toBe(200);
              const parsed = JSON.parse(data) as { ok: boolean };
              expect(parsed.ok).toBe(true);
              resolve();
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });

    await new Promise((r) => setTimeout(r, 20));
    const tasks = orch.list();
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.prompt).toContain("context was compacted");
  });
});
