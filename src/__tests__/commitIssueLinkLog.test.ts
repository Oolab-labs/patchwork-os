import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommitIssueLinkLog } from "../commitIssueLinkLog.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "link-log-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function base() {
  return {
    sha: "abc1234",
    ref: "#42",
    linkType: "closes" as const,
    resolved: true,
    workspace: "/ws/a",
    subject: "fix: x",
    issueState: "OPEN",
  };
}

describe("CommitIssueLinkLog", () => {
  it("records and assigns monotonic seq", () => {
    const log = new CommitIssueLinkLog({ dir, now: () => 1000 });
    expect(log.record(base())?.seq).toBe(1);
    expect(log.record({ ...base(), ref: "#43" })?.seq).toBe(2);
    expect(log.size()).toBe(2);
  });

  it("dedupes identical repeat calls (same workspace/sha/ref/state)", () => {
    const log = new CommitIssueLinkLog({ dir });
    expect(log.record(base())?.seq).toBe(1);
    expect(log.record(base())).toBeNull();
    expect(log.size()).toBe(1);
  });

  it("records a new row when issue state changes", () => {
    const log = new CommitIssueLinkLog({ dir });
    log.record(base());
    const next = log.record({ ...base(), issueState: "CLOSED" });
    expect(next?.seq).toBe(2);
    expect(log.size()).toBe(2);
  });

  it("records a new row when resolved flips true→false", () => {
    const log = new CommitIssueLinkLog({ dir });
    log.record(base());
    const next = log.record({
      ...base(),
      resolved: false,
      issueState: undefined,
      reason: "not_found",
    });
    expect(next?.seq).toBe(2);
  });

  it("query by ref returns matching rows newest-first", () => {
    const log = new CommitIssueLinkLog({ dir });
    log.record({ ...base(), sha: "aaa" });
    log.record({ ...base(), sha: "bbb" });
    log.record({ ...base(), sha: "ccc", ref: "#99" });
    const rows = log.query({ ref: "#42" });
    expect(rows.map((r) => r.sha)).toEqual(["bbb", "aaa"]);
  });

  it("query by sha prefix (≥7 chars) matches full SHAs", () => {
    const log = new CommitIssueLinkLog({ dir });
    log.record({ ...base(), sha: "abcdef1234567890" });
    expect(log.query({ sha: "abcdef1" })).toHaveLength(1);
    expect(log.query({ sha: "abcd" })).toHaveLength(0);
    expect(log.query({ sha: "abcdef1234567890" })).toHaveLength(1);
  });

  it("filters by workspace, linkType, and resolved", () => {
    const log = new CommitIssueLinkLog({ dir });
    log.record({ ...base(), sha: "a", workspace: "/ws/a" });
    log.record({
      ...base(),
      sha: "b",
      workspace: "/ws/b",
      linkType: "references",
    });
    log.record({
      ...base(),
      sha: "c",
      workspace: "/ws/a",
      resolved: false,
      issueState: undefined,
      reason: "gh_unavailable",
    });
    expect(log.query({ workspace: "/ws/a" })).toHaveLength(2);
    expect(log.query({ linkType: "references" })).toHaveLength(1);
    expect(log.query({ resolved: false })).toHaveLength(1);
  });

  it("persists to JSONL and reloads into a fresh instance", () => {
    const log1 = new CommitIssueLinkLog({ dir });
    log1.record(base());
    log1.record({ ...base(), ref: "#43" });
    const raw = readFileSync(
      path.join(dir, "commit_issue_links.jsonl"),
      "utf-8",
    );
    expect(raw.trim().split("\n")).toHaveLength(2);

    const log2 = new CommitIssueLinkLog({ dir });
    expect(log2.size()).toBe(2);
    const again = log2.record(base());
    expect(again).toBeNull();
  });

  it("skips malformed JSONL lines on load", () => {
    const log1 = new CommitIssueLinkLog({ dir });
    log1.record(base());
    const file = path.join(dir, "commit_issue_links.jsonl");
    const good = readFileSync(file, "utf-8");
    const fs = require("node:fs");
    fs.writeFileSync(file, `not json\n${good}{"no-seq":true}\n`);
    const log2 = new CommitIssueLinkLog({ dir });
    expect(log2.size()).toBe(1);
  });

  it("enforces memoryCap by trimming oldest", () => {
    const log = new CommitIssueLinkLog({ dir, memoryCap: 3 });
    for (let i = 0; i < 5; i += 1) {
      log.record({ ...base(), sha: `sha${i}` });
    }
    expect(log.size()).toBe(3);
    expect(log.query({}).map((r) => r.sha)).toEqual(["sha4", "sha3", "sha2"]);
  });

  it("respects query limit (1..1000)", () => {
    const log = new CommitIssueLinkLog({ dir });
    for (let i = 0; i < 10; i += 1) {
      log.record({ ...base(), sha: `sha${i}` });
    }
    expect(log.query({ limit: 3 })).toHaveLength(3);
    expect(log.query({ limit: 0 })).toHaveLength(1); // clamped to min 1
  });

  // ─── Tail-on-read (ADR-0007) ───────────────────────────────────────────
  it("tail-on-read: query() picks up rows appended by a sibling bridge", () => {
    const file = path.join(dir, "commit_issue_links.jsonl");
    const fs = require("node:fs") as typeof import("node:fs");

    const a = new CommitIssueLinkLog({ dir });
    a.record({ ...base(), sha: "sha-self-1" });

    // Simulate a sibling bridge appending directly. Higher seq so the
    // dedup guard (`seq > this.seq`) accepts the row.
    const externalRow = JSON.stringify({
      seq: 999,
      createdAt: 1,
      sha: "sha-sibling",
      ref: "#sibling",
      linkType: "fixes",
      resolved: true,
      workspace: "/ws/sibling",
      subject: "from sibling",
    });
    fs.appendFileSync(file, `${externalRow}\n`);

    const shas = a.query({}).map((r) => r.sha);
    expect(shas).toContain("sha-sibling");
    expect(shas).toContain("sha-self-1");
  });

  it("tail-on-read: self-appends don't get re-loaded as duplicates", () => {
    const log = new CommitIssueLinkLog({ dir });
    log.record({ ...base(), sha: "sha-x" });
    log.record({ ...base(), sha: "sha-y" });
    const first = log.query({}).map((r) => r.sha);
    const second = log.query({}).map((r) => r.sha);
    expect(first).toEqual(second);
    expect(first.filter((s) => s === "sha-x")).toHaveLength(1);
    expect(first.filter((s) => s === "sha-y")).toHaveLength(1);
  });
});
