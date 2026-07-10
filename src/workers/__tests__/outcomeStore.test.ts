import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyIssueDisposition,
  type OutcomeRecord,
  OutcomeStore,
  resolveOutcomeLogDir,
} from "../outcomeStore.js";

describe("resolveOutcomeLogDir — one file for every read + write path", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.PATCHWORK_HOME;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.PATCHWORK_HOME;
    else process.env.PATCHWORK_HOME = prev;
  });

  it("an explicit override always wins (test tmp dir / shadow opts.patchworkDir)", () => {
    process.env.PATCHWORK_HOME = "/env/pw";
    expect(resolveOutcomeLogDir("/override")).toBe("/override");
  });

  it("honors PATCHWORK_HOME when set (so write + trust-replay read agree)", () => {
    process.env.PATCHWORK_HOME = "/data/pw";
    expect(resolveOutcomeLogDir()).toBe("/data/pw");
  });

  it("falls back to ~/.patchwork when PATCHWORK_HOME is unset", () => {
    delete process.env.PATCHWORK_HOME;
    expect(resolveOutcomeLogDir()).toBe(path.join(os.homedir(), ".patchwork"));
  });
});

describe("classifyIssueDisposition", () => {
  it("labels signalling noise → junk (case-insensitive, substring)", () => {
    for (const label of [
      "invalid",
      "Duplicate",
      "WONTFIX",
      "won't fix",
      "not a bug",
      "by design",
      "spam",
      "status: duplicate", // substring match
    ]) {
      expect(
        classifyIssueDisposition({ state: "open", labels: [label] }),
        label,
      ).toBe("junk");
    }
  });

  it("state_reason 'not_planned' → junk (closed-as-not-planned)", () => {
    expect(
      classifyIssueDisposition({
        state: "closed",
        state_reason: "not_planned",
      }),
    ).toBe("junk");
  });

  it("closed-as-completed → confirmed (GitHub's default positive close)", () => {
    expect(
      classifyIssueDisposition({ state: "closed", state_reason: "completed" }),
    ).toBe("confirmed");
  });

  it("a positive label → confirmed", () => {
    for (const label of ["patchwork:valid", "confirmed", "verified"]) {
      expect(
        classifyIssueDisposition({ state: "open", labels: [label] }),
        label,
      ).toBe("confirmed");
    }
  });

  it("JUNK wins over confirmed signals (conservative precedence)", () => {
    // closed-as-completed BUT labelled duplicate → junk, not confirmed.
    expect(
      classifyIssueDisposition({
        state: "closed",
        state_reason: "completed",
        labels: ["duplicate"],
      }),
    ).toBe("junk");
    // not_planned outranks a positive label too.
    expect(
      classifyIssueDisposition({
        state: "closed",
        state_reason: "not_planned",
        labels: ["verified"],
      }),
    ).toBe("junk");
  });

  it("still-open / no clear signal → unknown (weak not-reverted rung)", () => {
    expect(classifyIssueDisposition({ state: "open" })).toBe("unknown");
    expect(classifyIssueDisposition({ state: "open", labels: [] })).toBe(
      "unknown",
    );
    // closed with no state_reason and no labels → unknown (not assumed good).
    expect(classifyIssueDisposition({ state: "closed" })).toBe("unknown");
    expect(classifyIssueDisposition({})).toBe("unknown");
  });

  it("accepts both string and {name} label shapes", () => {
    expect(
      classifyIssueDisposition({
        state: "open",
        labels: [{ name: "invalid" }, "other"],
      }),
    ).toBe("junk");
    // a malformed {name: undefined} entry must not throw.
    expect(
      classifyIssueDisposition({ state: "open", labels: [{}, "confirmed"] }),
    ).toBe("confirmed");
  });
});

describe("OutcomeStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "outcome-store-"));
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* OS reaps temp dir */
    }
  });

  const rec = (
    issueUrl: string,
    disposition: OutcomeRecord["disposition"],
    checkedAt = 1,
  ): OutcomeRecord => ({ issueUrl, disposition, checkedAt });

  it("returns null for an unknown URL (and a missing log file)", () => {
    const store = new OutcomeStore(dir);
    expect(store.getDisposition("https://x/issues/1")).toBeNull();
  });

  it("upsert → getDisposition round-trips, and the same instance sees its write", () => {
    const store = new OutcomeStore(dir);
    store.upsert(rec("https://x/issues/1", "junk"));
    expect(store.getDisposition("https://x/issues/1")).toBe("junk");
  });

  it("persists across instances (append-only JSONL on disk)", () => {
    new OutcomeStore(dir).upsert(rec("https://x/issues/1", "confirmed"));
    // A fresh instance lazy-loads from disk.
    expect(new OutcomeStore(dir).getDisposition("https://x/issues/1")).toBe(
      "confirmed",
    );
  });

  it("last-writer-wins: a later disposition supersedes an earlier one", () => {
    const store = new OutcomeStore(dir);
    store.upsert(rec("https://x/issues/1", "unknown", 1));
    store.upsert(rec("https://x/issues/1", "junk", 2));
    expect(store.getDisposition("https://x/issues/1")).toBe("junk");
    // and across a fresh read of the same append-only log:
    expect(new OutcomeStore(dir).getDisposition("https://x/issues/1")).toBe(
      "junk",
    );
  });

  it("skips malformed JSONL lines without throwing", () => {
    const logPath = path.join(dir, "outcome-log.jsonl");
    writeFileSync(
      logPath,
      [
        "{ not valid json",
        JSON.stringify(rec("https://x/issues/2", "confirmed")),
        "", // blank line
        '{"issueUrl":"","disposition":"junk"}', // empty key → ignored
      ].join("\n"),
      "utf-8",
    );
    const store = new OutcomeStore(dir);
    expect(store.getDisposition("https://x/issues/2")).toBe("confirmed");
    expect(store.getDisposition("")).toBeNull();
  });

  it("readAll dedupes to last-writer-wins full records", () => {
    const store = new OutcomeStore(dir);
    store.upsert(rec("https://x/issues/1", "unknown", 1));
    store.upsert(rec("https://x/issues/1", "confirmed", 2));
    store.upsert(rec("https://x/issues/3", "junk", 3));
    const all = store.readAll();
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.issueUrl.endsWith("/1"))?.disposition).toBe(
      "confirmed",
    );
    expect(all.find((r) => r.issueUrl.endsWith("/3"))?.disposition).toBe(
      "junk",
    );
  });

  it("a write from one instance invalidates the shared cache for all instances", () => {
    const a = new OutcomeStore(dir);
    const b = new OutcomeStore(dir);
    expect(b.getDisposition("https://x/issues/1")).toBeNull();
    a.upsert(rec("https://x/issues/1", "confirmed"));
    expect(b.getDisposition("https://x/issues/1")).toBe("confirmed");
  });

  describe("manual disposition is sticky against ingester overwrite", () => {
    it("a later ingester write does not overwrite an earlier manual disposition", () => {
      const store = new OutcomeStore(dir);
      store.upsert({
        issueUrl: "https://x/issues/1143",
        disposition: "junk",
        checkedAt: 1,
        origin: "manual",
      });
      store.upsert({
        issueUrl: "https://x/issues/1143",
        disposition: "confirmed",
        checkedAt: 2,
        origin: "ingester",
      });
      expect(store.getDisposition("https://x/issues/1143")).toBe("junk");
      expect(
        store.readAll().find((r) => r.issueUrl.endsWith("/1143"))?.origin,
      ).toBe("manual");
    });

    it("a later manual write still overwrites an earlier manual disposition", () => {
      const store = new OutcomeStore(dir);
      store.upsert({
        issueUrl: "https://x/issues/1143",
        disposition: "junk",
        checkedAt: 1,
        origin: "manual",
      });
      store.upsert({
        issueUrl: "https://x/issues/1143",
        disposition: "confirmed",
        checkedAt: 2,
        origin: "manual",
      });
      expect(store.getDisposition("https://x/issues/1143")).toBe("confirmed");
    });

    it("ingester writes still overwrite each other normally (no manual record present)", () => {
      const store = new OutcomeStore(dir);
      store.upsert({
        issueUrl: "https://x/issues/1",
        disposition: "unknown",
        checkedAt: 1,
        origin: "ingester",
      });
      store.upsert({
        issueUrl: "https://x/issues/1",
        disposition: "confirmed",
        checkedAt: 2,
        origin: "ingester",
      });
      expect(store.getDisposition("https://x/issues/1")).toBe("confirmed");
    });

    it("records written before the origin field existed are treated as ingester (no special protection)", () => {
      const store = new OutcomeStore(dir);
      // Legacy record, no `origin` — same shape as everything written
      // before this fix.
      store.upsert(rec("https://x/issues/1", "junk"));
      store.upsert({
        issueUrl: "https://x/issues/1",
        disposition: "confirmed",
        checkedAt: 2,
        origin: "ingester",
      });
      expect(store.getDisposition("https://x/issues/1")).toBe("confirmed");
    });
  });
});
