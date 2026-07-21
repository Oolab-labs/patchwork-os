import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BridgeLockInfo } from "../../bridgeLockDiscovery.js";
import { runCodexDoctor } from "../codexDoctor.js";

const VALID_ENTRY = (url: string, token: string) => `
[mcp_servers.claude-ide-bridge]
url = "${url}"
http_headers = { "Authorization" = "Bearer ${token}" }
enabled = true
`;

const LIVE_LOCK: BridgeLockInfo = {
  port: 37299,
  authToken: "live-token-abc",
  pid: 1234,
  workspace: "/fake/workspace",
};

describe("runCodexDoctor", () => {
  let tempDir = "";
  let configPath = "";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-doctor-"));
    configPath = path.join(tempDir, "config.toml");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("fails when the config file does not exist", async () => {
    const result = await runCodexDoctor({
      configPath,
      findBridgeLockFn: () => null,
    });
    expect(result.ok).toBe(false);
    const check = result.checks.find((c) => c.name === "Codex config file")!;
    expect(check.status).toBe("fail");
    expect(check.suggestion).toContain("gen-mcp-config.sh codex");
  });

  it("fails when the config exists but has no bridge MCP server entry", async () => {
    fs.writeFileSync(configPath, "# empty config, no bridge entry\n");
    const result = await runCodexDoctor({
      configPath,
      findBridgeLockFn: () => null,
    });
    expect(result.ok).toBe(false);
    const check = result.checks.find(
      (c) => c.name === "Bridge MCP server entry",
    )!;
    expect(check.status).toBe("fail");
  });

  it("warns (not fails) when no live bridge is discoverable — config alone can be valid while the bridge is simply not running", async () => {
    fs.writeFileSync(
      configPath,
      VALID_ENTRY("http://127.0.0.1:37299/mcp", "live-token-abc"),
    );
    const result = await runCodexDoctor({
      configPath,
      findBridgeLockFn: () => null,
    });
    const check = result.checks.find((c) => c.name === "Live bridge")!;
    expect(check.status).toBe("warn");
    // No live bridge means no port/token comparison possible — must not
    // spuriously fail on those either.
    expect(
      result.checks.find((c) => c.name === "Config port matches live bridge"),
    ).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it("passes fully when config and live bridge port+token agree", async () => {
    fs.writeFileSync(
      configPath,
      VALID_ENTRY("http://127.0.0.1:37299/mcp", "live-token-abc"),
    );
    const result = await runCodexDoctor({
      configPath,
      findBridgeLockFn: () => LIVE_LOCK,
    });
    expect(result.ok).toBe(true);
    expect(result.checks.every((c) => c.status !== "fail")).toBe(true);
  });

  it("fails when the config's port doesn't match the live bridge's current port (stale config after a restart)", async () => {
    fs.writeFileSync(
      configPath,
      VALID_ENTRY("http://127.0.0.1:19999/mcp", "live-token-abc"),
    );
    const result = await runCodexDoctor({
      configPath,
      findBridgeLockFn: () => LIVE_LOCK,
    });
    expect(result.ok).toBe(false);
    const check = result.checks.find(
      (c) => c.name === "Config port matches live bridge",
    )!;
    expect(check.status).toBe("fail");
    expect(check.suggestion).toContain("gen-mcp-config.sh codex");
  });

  it("fails when the config's Bearer token doesn't match the live bridge's current token (stale token)", async () => {
    fs.writeFileSync(
      configPath,
      VALID_ENTRY("http://127.0.0.1:37299/mcp", "stale-old-token"),
    );
    const result = await runCodexDoctor({
      configPath,
      findBridgeLockFn: () => LIVE_LOCK,
    });
    expect(result.ok).toBe(false);
    const check = result.checks.find(
      (c) => c.name === "Config auth token matches live bridge",
    )!;
    expect(check.status).toBe("fail");
  });

  it("warns on an unusual URL shape instead of hard-failing (may be a legitimate custom deployment)", async () => {
    fs.writeFileSync(
      configPath,
      VALID_ENTRY("http://127.0.0.1:37299/weird-path", "live-token-abc"),
    );
    const result = await runCodexDoctor({
      configPath,
      findBridgeLockFn: () => null,
    });
    const check = result.checks.find(
      (c) => c.name === "Bridge MCP server entry",
    )!;
    expect(check.status).toBe("warn");
    expect(result.ok).toBe(true);
  });
});
