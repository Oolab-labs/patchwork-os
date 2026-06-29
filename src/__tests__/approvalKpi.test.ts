/**
 * Considered-approval KPI aggregator — the lens that separates judgement from
 * rubber-stamping. Tests the read (human decisions only, outcome classification,
 * latency field) and the aggregation (reject rate over DECIDED, abandoned kept
 * separate from rejections, latency/channel/per-day rollups).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeConsideredApprovalKpi,
  readConsideredDecisions,
} from "../approvalKpi.js";

let ideDir: string;

/** Build one ActivityLog `approval_decision` line. */
function decisionLine(o: {
  ts: string;
  toolName: string;
  decision: "allow" | "deny";
  reason: string;
  requestedAt?: number;
  channel?: string;
  tier?: string;
  callId?: string;
}): string {
  return JSON.stringify({
    event: "approval_decision",
    timestamp: o.ts,
    metadata: {
      toolName: o.toolName,
      decision: o.decision,
      reason: o.reason,
      ...(o.requestedAt !== undefined && { requestedAt: o.requestedAt }),
      ...(o.channel !== undefined && { channel: o.channel }),
      ...(o.tier !== undefined && { tier: o.tier }),
      ...(o.callId !== undefined && { callId: o.callId }),
    },
  });
}

beforeEach(() => {
  ideDir = mkdtempSync(path.join(os.tmpdir(), "kpi-ide-"));
  mkdirSync(ideDir, { recursive: true });
});
afterEach(() => rmSync(ideDir, { recursive: true, force: true }));

describe("readConsideredDecisions", () => {
  it("keeps human-deliberated decisions and drops instant-policy emits", () => {
    const t0 = Date.parse("2026-06-29T10:00:00.000Z");
    writeFileSync(
      path.join(ideDir, "activity-1.jsonl"),
      [
        // human approve via dashboard, 12s deliberation
        decisionLine({
          ts: "2026-06-29T10:00:12.000Z",
          toolName: "github.create_issue",
          decision: "allow",
          reason: "approved",
          requestedAt: t0,
          channel: "dashboard",
        }),
        // human reject via phone, 40s
        decisionLine({
          ts: "2026-06-29T10:00:40.000Z",
          toolName: "github.create_issue",
          decision: "deny",
          reason: "rejected",
          requestedAt: t0,
          channel: "phone",
        }),
        // expired prompt → abandoned, NOT a rejection. Abandonment happens
        // server-side on the CC-hook path (no channel — you can't *click* an
        // expired prompt), so this row carries no channel.
        decisionLine({
          ts: "2026-06-29T10:05:00.000Z",
          toolName: "github.create_issue",
          decision: "deny",
          reason: "expired",
          requestedAt: t0,
        }),
        // instant policy — must be excluded (no human)
        decisionLine({
          ts: "2026-06-29T10:06:00.000Z",
          toolName: "getGitStatus",
          decision: "allow",
          reason: "gate_below_threshold",
        }),
        decisionLine({
          ts: "2026-06-29T10:07:00.000Z",
          toolName: "readFile",
          decision: "allow",
          reason: "gate_off",
        }),
        // legacy human row (no requestedAt) — kept, but no latency
        decisionLine({
          ts: "2026-06-28T09:00:00.000Z",
          toolName: "gitPush",
          decision: "allow",
          reason: "approved",
          channel: "dashboard",
        }),
        "",
        "not-json",
      ].join("\n"),
    );
    const decisions = readConsideredDecisions({ ideDir });
    // 3 issue decisions + 1 legacy gitPush; the 2 instant-policy excluded
    expect(decisions).toHaveLength(4);
    expect(decisions.every((d) => d.toolName !== "getGitStatus")).toBe(true);
    expect(decisions.every((d) => d.toolName !== "readFile")).toBe(true);
    // chronological
    expect(decisions[0]?.toolName).toBe("gitPush"); // 06-28 first
    // outcome classification: expired → abandoned, not rejected
    const expired = decisions.find((d) => d.outcome === "abandoned");
    expect(expired).toBeDefined();
    expect(expired?.toolName).toBe("github.create_issue");
  });

  it("respects the sinceMs window", () => {
    writeFileSync(
      path.join(ideDir, "activity-1.jsonl"),
      [
        decisionLine({
          ts: "2026-06-20T10:00:00.000Z",
          toolName: "gitPush",
          decision: "allow",
          reason: "approved",
        }),
        decisionLine({
          ts: "2026-06-29T10:00:00.000Z",
          toolName: "gitPush",
          decision: "allow",
          reason: "approved",
        }),
      ].join("\n"),
    );
    const recent = readConsideredDecisions({
      ideDir,
      sinceMs: Date.parse("2026-06-25T00:00:00.000Z"),
    });
    expect(recent).toHaveLength(1);
    expect(recent[0]?.decidedAt).toBe(Date.parse("2026-06-29T10:00:00.000Z"));
  });

  it("captures worker-gate approvals (dashboard/phone channel, no reason)", () => {
    // The path that actually matters: worker-gate approvals land on
    // POST /approve|reject, which sets `channel` but no outcome `reason`. The
    // earlier filter (reason/requestedAt only) silently dropped these.
    const t0 = Date.parse("2026-06-29T11:00:00.000Z");
    writeFileSync(
      path.join(ideDir, "activity-2.jsonl"),
      [
        // dashboard approve — channel set, no reason, no requestedAt (legacy)
        decisionLine({
          ts: "2026-06-29T11:00:08.000Z",
          toolName: "github.create_issue",
          decision: "allow",
          reason: "",
          channel: "dashboard",
        }),
        // phone approve WITH requestedAt (post-instrumentation) → 20s latency
        decisionLine({
          ts: "2026-06-29T11:01:20.000Z",
          toolName: "github.create_issue",
          decision: "allow",
          reason: "",
          requestedAt: t0 + 60_000,
          channel: "phone",
        }),
        // dashboard REJECT with free-form reason text — must NOT be read as
        // "abandoned" just because reason text exists.
        decisionLine({
          ts: "2026-06-29T11:02:00.000Z",
          toolName: "github.create_issue",
          decision: "deny",
          reason: "flaky test, not a real bug",
          channel: "dashboard",
        }),
      ].join("\n"),
    );
    const ds = readConsideredDecisions({ ideDir });
    expect(ds).toHaveLength(3);
    expect(ds.filter((d) => d.outcome === "approved")).toHaveLength(2);
    const rej = ds.find((d) => d.outcome === "rejected");
    expect(rej?.channel).toBe("dashboard");
    expect(ds.some((d) => d.outcome === "abandoned")).toBe(false);
    const kpi = computeConsideredApprovalKpi(ds);
    expect(kpi.rejectRate).toBeCloseTo(1 / 3);
    expect(kpi.latency?.count).toBe(1); // only the requestedAt row
    expect(kpi.channels).toEqual({ dashboard: 2, phone: 1 });
  });

  it("dedups the two rows a single human decision emits (callId), keeping the channel'd one", () => {
    // Production reality (the HIGH the review caught): a CC-hook approval
    // resolved via the dashboard emits BOTH a POST row (channel'd, no reason)
    // and the awaiting CC-hook row (no channel, reason'd) — same callId, same
    // outcome. Counting both ~2x-inflates and injects a phantom "unknown".
    const t0 = Date.parse("2026-06-29T12:00:00.000Z");
    writeFileSync(
      path.join(ideDir, "activity-3.jsonl"),
      [
        decisionLine({
          ts: "2026-06-29T12:00:09.000Z",
          toolName: "Bash",
          decision: "allow",
          reason: "",
          requestedAt: t0,
          channel: "dashboard",
          callId: "abc-123",
        }),
        decisionLine({
          ts: "2026-06-29T12:00:09.000Z",
          toolName: "Bash",
          decision: "allow",
          reason: "approved",
          requestedAt: t0,
          callId: "abc-123", // same decision, CC-hook dup (no channel)
        }),
      ].join("\n"),
    );
    const ds = readConsideredDecisions({ ideDir });
    expect(ds).toHaveLength(1); // collapsed, not 2
    expect(ds[0]?.channel).toBe("dashboard"); // kept the channel'd row
    const kpi = computeConsideredApprovalKpi(ds);
    expect(kpi.decided).toBe(1);
    expect(kpi.channels).toEqual({ dashboard: 1 }); // no phantom "unknown"
  });

  it("returns [] for a missing ide dir (fail-soft)", () => {
    expect(readConsideredDecisions({ ideDir: "/no/such/dir" })).toEqual([]);
  });
});

describe("computeConsideredApprovalKpi", () => {
  it("computes reject rate over DECIDED (abandoned excluded from the denominator)", () => {
    const base = Date.parse("2026-06-29T10:00:00.000Z");
    const decisions = [
      { outcome: "approved", channel: "dashboard", decidedAt: base + 1000 },
      { outcome: "approved", channel: "phone", decidedAt: base + 2000 },
      { outcome: "rejected", channel: "dashboard", decidedAt: base + 3000 },
      { outcome: "abandoned", channel: "unknown", decidedAt: base + 4000 },
    ].map((d) => ({ toolName: "github.create_issue", ...d })) as never;
    const kpi = computeConsideredApprovalKpi(decisions);
    expect(kpi.total).toBe(4);
    expect(kpi.decided).toBe(3); // abandoned excluded
    expect(kpi.approved).toBe(2);
    expect(kpi.rejected).toBe(1);
    expect(kpi.abandoned).toBe(1);
    expect(kpi.rejectRate).toBeCloseTo(1 / 3); // 1 reject / 3 decided, not /4
  });

  it("derives latency stats only from rows carrying requestedAt", () => {
    const base = Date.parse("2026-06-29T10:00:00.000Z");
    const decisions = [
      // 10s and 30s deliberations
      {
        toolName: "github.create_issue",
        outcome: "approved",
        channel: "phone",
        decidedAt: base + 10_000,
        requestedAt: base,
      },
      {
        toolName: "github.create_issue",
        outcome: "rejected",
        channel: "dashboard",
        decidedAt: base + 30_000,
        requestedAt: base,
      },
      // legacy row — no requestedAt → excluded from latency
      {
        toolName: "github.create_issue",
        outcome: "approved",
        channel: "dashboard",
        decidedAt: base + 99_000,
      },
    ] as never;
    const kpi = computeConsideredApprovalKpi(decisions);
    expect(kpi.latency?.count).toBe(2); // legacy row excluded
    expect(kpi.latency?.medianMs).toBe(20_000); // interpolated median of [10s,30s]
    expect(kpi.channels).toEqual({ phone: 1, dashboard: 2 });
    expect(kpi.byTool[0]?.toolName).toBe("github.create_issue");
  });

  it("rubber-stamp signature: 100% approve, near-zero latency", () => {
    const base = Date.parse("2026-06-29T10:00:00.000Z");
    const decisions = Array.from({ length: 8 }, (_, i) => ({
      toolName: "github.create_issue",
      outcome: "approved" as const,
      channel: "phone",
      decidedAt: base + i * 1000 + 200,
      requestedAt: base + i * 1000, // 200ms taps
    })) as never;
    const kpi = computeConsideredApprovalKpi(decisions);
    expect(kpi.rejectRate).toBe(0); // never said no
    expect(kpi.latency?.medianMs).toBeLessThan(1000); // reflexive
  });

  it("empty input → zeroed report", () => {
    const kpi = computeConsideredApprovalKpi([]);
    expect(kpi).toMatchObject({
      total: 0,
      decided: 0,
      rejectRate: 0,
      latency: null,
      byTool: [],
      perDay: [],
    });
  });
});
