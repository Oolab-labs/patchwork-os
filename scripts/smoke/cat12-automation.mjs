/**
 * Category 12 — Automation hooks: policy validation, notify fires hook.
 * Usage: node cat12-automation.mjs
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, sleep, summary, waitForBridge } from "./helpers.mjs";

const BRIDGE = process.env.BRIDGE ?? "claude-ide-bridge";
const PORT = 37250;
const ENV = {
  ...process.env,
  CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "smoke-auto-cfg-")),
};
fs.mkdirSync(path.join(ENV.CLAUDE_CONFIG_DIR, "ide"), { recursive: true });

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-auto-ws-"));
const POLICY_PATH = path.join(workspace, "policy.json");

console.log("\n[CAT-12] Automation hooks");

// 12.1 Valid policy → bridge starts cleanly
const validPolicy = {
  onFileSave: {
    enabled: false,
    patterns: ["**/*.ts"],
    prompt: "file saved: {{file}}",
    cooldownMs: 5000,
  },
};
fs.writeFileSync(POLICY_PATH, JSON.stringify(validPolicy, null, 2));

{
  let stderrOut = "";
  const proc = spawn(
    BRIDGE,
    [
      "--port",
      String(PORT),
      "--workspace",
      workspace,
      "--automation",
      "--automation-policy",
      POLICY_PATH,
    ],
    { env: ENV, stdio: ["ignore", "ignore", "pipe"] },
  );
  proc.stderr.on("data", (d) => (stderrOut += d));

  let started = false;
  try {
    await waitForBridge(PORT, 8000, ENV.CLAUDE_CONFIG_DIR);
    started = true;
  } catch {
    /* bridge didn't start */
  }

  assert(started, "12.1 valid policy → bridge starts");
  const hasInvalidErr = /invalid policy|policy.*error|SyntaxError/i.test(
    stderrOut,
  );
  assert(
    !hasInvalidErr,
    `12.1 no 'invalid policy' in stderr (got: ${stderrOut.slice(0, 200)})`,
  );

  // 12.3 notify valid event reaches bridge
  if (started) {
    let notifyOk = false;
    try {
      execFileSync(
        BRIDGE,
        [
          "notify",
          "PostToolUse",
          "--tool",
          "Bash",
          "--cwd",
          workspace,
          "--port",
          String(PORT),
        ],
        { env: ENV, timeout: 3000 },
      );
      notifyOk = true;
    } catch (e) {
      // notify may exit non-zero if bridge isn't in automation mode or event not registered
      // — acceptable if error is "event not handled" not "connection refused"
      notifyOk = !/ECONNREFUSED|connect ECONNREFUSED/i.test(e.message);
    }
    assert(
      notifyOk,
      "12.3 notify PostToolUse reaches bridge without ECONNREFUSED",
    );
  }

  proc.kill();
  await sleep(500);
}

// 12.2 Bad JSON policy → bridge exits non-zero
{
  const badPolicyPath = path.join(workspace, "bad-policy.json");
  fs.writeFileSync(badPolicyPath, "{ bad json here }");

  let exitCode = null;
  const proc = spawn(
    BRIDGE,
    [
      "--port",
      String(PORT + 1),
      "--workspace",
      workspace,
      "--automation",
      "--automation-policy",
      badPolicyPath,
    ],
    { env: ENV, stdio: ["ignore", "ignore", "ignore"] },
  );

  await new Promise((r) =>
    proc.on("exit", (code) => {
      exitCode = code;
      r();
    }),
  );
  assert(
    exitCode !== 0,
    `12.2 bad JSON policy → non-zero exit (got ${exitCode})`,
  );
}

fs.rmSync(workspace, { recursive: true, force: true });

summary("CAT-12");
