import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AmbiguousActionRefError,
  canonicalActionRef,
  deriveActionKey,
} from "../actionRef.js";
import { OutcomeStore } from "../outcomeStore.js";
import { foldOutcome } from "../shadowObserver.js";

/**
 * The output SHAPE `todoist.create_task` actually returned in the first real
 * governed errand run — field names and types transcribed from a live
 * `runs.jsonl` row, with the account-specific values replaced by same-shape
 * placeholders (this repo is public; the real ids are not).
 *
 * The fidelity that matters here is the ABSENCE of `url`, not the id values.
 * The bug being fixed survived 26 green mock tests precisely because those
 * mocks carried a `url` the live Todoist API has never returned — it exposes
 * no permalink field at all. A fixture written from imagination would
 * reproduce exactly that failure, so the field set is copied, not invented.
 */
const TODOIST_CREATE_OUTPUT = {
  user_id: "00000000",
  id: "AaBbCcDdEeFfGgHh",
  project_id: "HhGgFfEeDdCcBbAa",
  section_id: null,
  parent_id: null,
  content: "Renew the road tax",
  checked: false,
};

describe("canonicalActionRef", () => {
  it("joins tool and id", () => {
    expect(canonicalActionRef({ tool: "todoist.create_task", id: "abc" })).toBe(
      "todoist.create_task:abc",
    );
  });

  it("refuses a URL-shaped key so it cannot collide with legacy issueUrl keys", () => {
    expect(() =>
      canonicalActionRef({ tool: "https://evil", id: "1" }),
    ).toThrowError(AmbiguousActionRefError);
  });

  it("refuses a half-empty ref rather than writing a key nothing looks up", () => {
    expect(() => canonicalActionRef({ tool: "t", id: "  " })).toThrowError(
      AmbiguousActionRefError,
    );
    expect(() => canonicalActionRef({ tool: "", id: "x" })).toThrowError(
      AmbiguousActionRefError,
    );
  });
});

describe("deriveActionKey", () => {
  it("derives a key from the REAL todoist.create_task output (which has no url)", () => {
    // Anchor assertion: if this fixture ever gains a `url`, the test below
    // stops proving anything, so assert the absence explicitly.
    expect("url" in TODOIST_CREATE_OUTPUT).toBe(false);
    expect(deriveActionKey("todoist.create_task", TODOIST_CREATE_OUTPUT)).toBe(
      "todoist.create_task:AaBbCcDdEeFfGgHh",
    );
  });

  it("keeps a URL as the key itself, so legacy issueUrl rows still join", () => {
    expect(
      deriveActionKey("github.create_issue", {
        url: "https://github.com/o/r/issues/7",
        id: 99,
      }),
    ).toBe("https://github.com/o/r/issues/7");
  });

  it("accepts numeric ids", () => {
    expect(deriveActionKey("x.create", { id: 41 })).toBe("x.create:41");
  });

  it("returns null when there is genuinely nothing to key on", () => {
    expect(deriveActionKey("file.write", { path: "/p", bytesWritten: 0 })).toBe(
      null,
    );
    expect(deriveActionKey("x.create", "a string output")).toBe(null);
    expect(deriveActionKey(undefined, { id: "1" })).toBe(null);
  });
});

describe("outcome store keys both shapes without a migration", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "outcome-ref-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads a legacy issueUrl row and a new ref row from the same log", () => {
    const store = new OutcomeStore(dir);
    store.upsert({
      issueUrl: "https://github.com/o/r/issues/1",
      disposition: "confirmed",
      checkedAt: 1,
    });
    store.upsert({
      ref: { tool: "todoist.create_task", id: "AaBbCcDdEeFfGgHh" },
      disposition: "junk",
      checkedAt: 2,
    });
    expect(store.getDisposition("https://github.com/o/r/issues/1")).toBe(
      "confirmed",
    );
    expect(
      store.getDispositionForRef({
        tool: "todoist.create_task",
        id: "AaBbCcDdEeFfGgHh",
      }),
    ).toBe("junk");
    expect(store.unkeyableRows()).toEqual([]);
  });

  it("refuses to write a record nothing could look up", () => {
    const store = new OutcomeStore(dir);
    expect(() =>
      store.upsert({ disposition: "confirmed", checkedAt: 1 }),
    ).toThrowError(AmbiguousActionRefError);
  });

  it("REPORTS unkeyable rows instead of silently dropping them", () => {
    const log = path.join(dir, "outcome-log.jsonl");
    writeFileSync(
      log,
      [
        JSON.stringify({
          issueUrl: "https://x/1",
          disposition: "confirmed",
          checkedAt: 1,
        }),
        "{ not json",
        JSON.stringify({ disposition: "confirmed", checkedAt: 2 }),
        JSON.stringify({ issueUrl: "https://x/2", checkedAt: 3 }),
      ].join("\n"),
      "utf-8",
    );
    const rows = new OutcomeStore(dir).unkeyableRows();
    expect(rows.map((r) => [r.line, r.reason])).toEqual([
      [2, "malformed-json"],
      [3, "no-key"],
      [4, "no-disposition"],
    ]);
    // The healthy row still parses — reporting holes must not lose good data.
    expect(new OutcomeStore(dir).getDisposition("https://x/1")).toBe(
      "confirmed",
    );
  });
});

describe("foldOutcome: the join gate", () => {
  let dir: string;
  const WINDOW = 24 * 60 * 60 * 1000;
  const now = 1_800_000_000_000;
  const settled = now - WINDOW * 2; // well past the durability window

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "outcome-fold-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const todoistStep = {
    tool: "todoist.create_task",
    status: "ok" as const,
    output: TODOIST_CREATE_OUTPUT,
  };

  /**
   * THE BUG, PINNED. A compensable success with no URL was folded as earned
   * trust — full credit for an action no human ever confirmed. This asserts
   * the pre-fix behaviour is still what the default (lenient) path does, so
   * PR1 is provably inert; the strict path below is what changes it.
   */
  it("default (lenient) join still credits an unconfirmed non-URL action", () => {
    const d = foldOutcome(todoistStep, settled, {
      now,
      windowMs: WINDOW,
      outcomeStore: new OutcomeStore(dir),
    });
    expect(d).toEqual({ fold: true, good: true });
  });

  it("strict join WITHHOLDS the same action, because nobody confirmed it", () => {
    const d = foldOutcome(todoistStep, settled, {
      now,
      windowMs: WINDOW,
      outcomeStore: new OutcomeStore(dir),
      strictOutcomeJoin: true,
    });
    expect(d).toEqual({ fold: false });
  });

  it("strict join CREDITS the action once an operator confirms it", () => {
    const store = new OutcomeStore(dir);
    store.upsert({
      ref: { tool: "todoist.create_task", id: "AaBbCcDdEeFfGgHh" },
      disposition: "confirmed",
      checkedAt: now,
      origin: "manual",
    });
    const d = foldOutcome(todoistStep, settled, {
      now,
      windowMs: WINDOW,
      outcomeStore: store,
      strictOutcomeJoin: true,
    });
    expect(d).toEqual({ fold: true, good: true });
  });

  it("strict join DEMOTES on rejection, immediately", () => {
    const store = new OutcomeStore(dir);
    store.upsert({
      ref: { tool: "todoist.create_task", id: "AaBbCcDdEeFfGgHh" },
      disposition: "junk",
      checkedAt: now,
      origin: "manual",
    });
    const d = foldOutcome(todoistStep, settled, {
      now,
      windowMs: WINDOW,
      outcomeStore: store,
      strictOutcomeJoin: true,
    });
    expect(d).toEqual({ fold: true, good: false });
  });

  it("reversible actions are unaffected by either join rule", () => {
    const step = {
      tool: "file.read",
      status: "ok" as const,
      output: { id: "z" },
    };
    for (const strict of [false, true]) {
      expect(
        foldOutcome(step, settled, {
          now,
          windowMs: WINDOW,
          outcomeStore: new OutcomeStore(dir),
          strictOutcomeJoin: strict,
        }),
      ).toEqual({ fold: true, good: true });
    }
  });
});
