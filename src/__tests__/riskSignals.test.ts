/**
 * audit P0-2 — content-aware in-process approval gate.
 *
 * The bridge's OWN MCP tools (runCommand/runInTerminal/sendTerminalCommand/…)
 * were gated on risk TIER alone: riskSignals were hardcoded to [] and a
 * high-severity content signal never escalated a sub-high tool. These tests
 * pin the extracted, shared logic in src/riskSignals.ts:
 *   - computeRiskSignals: the catalog (incl. new terraform/pulumi entries and
 *     the sendTerminalCommand `text` param key), and benign input → no signals.
 *   - evaluateInProcessGate: off→bypass, all→queue, high-tier→queue-with-signals,
 *     and the escalation (sub-high tier + high-severity signal → queue).
 */

import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { computeRiskSignals, evaluateInProcessGate } from "../riskSignals.js";

const WS = path.resolve("riskSignals-test-ws");
const OUTSIDE = path.resolve(path.dirname(WS), "outside-the-workspace.txt");
const INSIDE = path.join(WS, "inside.txt");

describe("computeRiskSignals — command catalog", () => {
  it("flags rm -rf as high severity (runCommand uses params.command)", () => {
    const s = computeRiskSignals(
      "runCommand",
      { command: "rm -rf ./build" },
      WS,
    );
    expect(s).toContainEqual({
      kind: "destructive_flag",
      label: "rm with -rf flags",
      severity: "high",
    });
  });

  it("returns no signals for a benign command", () => {
    expect(computeRiskSignals("runCommand", { command: "ls -la" }, WS)).toEqual(
      [],
    );
  });

  it("flags terraform destroy as high severity", () => {
    const s = computeRiskSignals(
      "runInTerminal",
      { command: "terraform destroy -auto-approve" },
      WS,
    );
    expect(s).toContainEqual({
      kind: "destructive_flag",
      label: "terraform destroy",
      severity: "high",
    });
  });

  it("flags pulumi destroy as high severity", () => {
    const s = computeRiskSignals(
      "runCommand",
      { command: "pulumi destroy -y" },
      WS,
    );
    expect(s).toContainEqual({
      kind: "destructive_flag",
      label: "pulumi destroy",
      severity: "high",
    });
  });

  it("reads sendTerminalCommand from params.text (not params.command)", () => {
    const s = computeRiskSignals(
      "sendTerminalCommand",
      { text: "sudo rm -rf /" },
      WS,
    );
    expect(s.some((x) => x.severity === "high")).toBe(true);
    expect(s.map((x) => x.label)).toContain("rm with -rf flags");
    expect(s.map((x) => x.label)).toContain("runs as sudo");
  });

  it("flags non-HTTPS and direct-IP URLs for sendHttpRequest", () => {
    const s = computeRiskSignals(
      "sendHttpRequest",
      { url: "http://1.2.3.4/exfil" },
      WS,
    );
    expect(s.map((x) => x.label)).toContain("non-HTTPS URL");
    expect(s.map((x) => x.label)).toContain("direct IP address");
  });

  it("flags a file path that escapes the workspace as high severity", () => {
    const s = computeRiskSignals("Read", { file_path: OUTSIDE }, WS);
    expect(s).toContainEqual({
      kind: "path_escape",
      label: "file path outside workspace",
      severity: "high",
    });
  });

  it("does not flag a file path inside the workspace", () => {
    expect(computeRiskSignals("Read", { file_path: INSIDE }, WS)).toEqual([]);
  });
});

describe("evaluateInProcessGate — decision + escalation", () => {
  it("gate 'off' always bypasses (even a destructive command)", () => {
    const d = evaluateInProcessGate({
      toolName: "runCommand",
      params: { command: "rm -rf /" },
      gate: "off",
      workspace: WS,
    });
    expect(d.decision).toBe("bypass");
  });

  it("gate 'high' queues a high-tier tool and carries its risk signals", () => {
    const d = evaluateInProcessGate({
      toolName: "runCommand",
      params: { command: "rm -rf ./build" },
      gate: "high",
      workspace: WS,
    });
    expect(d.decision).toBe("queue");
    if (d.decision === "queue") {
      expect(d.tier).toBe("high");
      expect(d.riskSignals.some((s) => s.severity === "high")).toBe(true);
    }
  });

  it("ESCALATION: a sub-high tool carrying a high-severity signal is forced to queue", () => {
    // classifyTool('Read') === 'medium'; a workspace-escaping path is a high
    // signal. Pre-fix this bypassed (tier !== 'high'); now it must queue.
    const d = evaluateInProcessGate({
      toolName: "Read",
      params: { file_path: OUTSIDE },
      gate: "high",
      workspace: WS,
    });
    expect(d.decision).toBe("queue");
  });

  it("gate 'high' bypasses a sub-high tool with no high-severity signal", () => {
    const d = evaluateInProcessGate({
      toolName: "Read",
      params: { file_path: INSIDE },
      gate: "high",
      workspace: WS,
    });
    expect(d.decision).toBe("bypass");
  });

  it("gate 'all' queues everything, including a benign sub-high tool", () => {
    const d = evaluateInProcessGate({
      toolName: "getDiagnostics",
      params: {},
      gate: "all",
      workspace: WS,
    });
    expect(d.decision).toBe("queue");
  });
});
