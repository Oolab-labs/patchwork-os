import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyActionClass } from "../actionClass.js";
import { OutcomeStore } from "../outcomeStore.js";
import { foldOutcome } from "../shadowObserver.js";

const WINDOW = 24 * 60 * 60 * 1000;
const now = 1_800_000_000_000;
const settled = now - WINDOW * 2;

/**
 * The real `http.post` output shape from the run log: the response id lives
 * INSIDE `body`, a JSON string, so `deriveActionKey` finds nothing at the top
 * level. Deliberately not "fixed" by parsing the body — see the PR rationale.
 */
const HTTP_POST_OUTPUT = {
  status: 200,
  ok: true,
  body: '{"id":"qSiCVuBRWYbk","topic":"t","message":"m"}',
};

describe("an unidentifiable action is not an approved one", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "unkeyable-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("http.post is irreversible and brand-exposed — the premise", () => {
    // Anchor: if this ever reclassifies to reversible, the test below passes
    // for the wrong reason (reversible short-circuits before the join).
    const ac = classifyActionClass("http.post");
    expect(ac.reversibility).toBe("irreversible");
    expect(ac.brandExposed).toBe(true);
  });

  it("its id is NOT reachable at the top level — the reason it is unkeyable", () => {
    expect(Object.hasOwn(HTTP_POST_OUTPUT, "id")).toBe(false);
    expect(Object.hasOwn(HTTP_POST_OUTPUT, "url")).toBe(false);
  });

  /** THE FIX. Previously fell through to {fold:true, good:true}. */
  it("WITHHOLDS an unkeyable non-reversible success when a store is configured", () => {
    expect(
      foldOutcome(
        { tool: "http.post", status: "ok", output: HTTP_POST_OUTPUT },
        settled,
        {
          now,
          windowMs: WINDOW,
          outcomeStore: new OutcomeStore(dir),
        },
      ),
    ).toEqual({ fold: false });
  });

  it("withholds when the step captured no output at all", () => {
    expect(
      foldOutcome({ tool: "http.post", status: "ok" }, settled, {
        now,
        windowMs: WINDOW,
        outcomeStore: new OutcomeStore(dir),
      }),
    ).toEqual({ fold: false });
  });

  /**
   * Scope boundary. With no store wired, nothing can ever be confirmed;
   * withholding would silently zero every non-reversible action for callers
   * that never opted into outcome tracking. That is a deployment state, not a
   * property of the action.
   */
  it("does NOT withhold when no outcome store is configured", () => {
    expect(
      foldOutcome(
        { tool: "http.post", status: "ok", output: HTTP_POST_OUTPUT },
        settled,
        {
          now,
          windowMs: WINDOW,
        },
      ),
    ).toEqual({ fold: true, good: true });
  });

  it("does NOT withhold a REVERSIBLE unkeyable success (anchor)", () => {
    // Reversible actions are always durable — they must be unaffected, or this
    // change would starve the dial of its ordinary evidence.
    expect(
      foldOutcome(
        { tool: "file.read", status: "ok", output: { bytes: 12 } },
        settled,
        {
          now,
          windowMs: WINDOW,
          outcomeStore: new OutcomeStore(dir),
        },
      ),
    ).toEqual({ fold: true, good: true });
  });

  it("a KEYABLE + confirmed action still counts (anchor)", () => {
    const store = new OutcomeStore(dir);
    store.upsert({
      ref: { tool: "todoist.create_task", id: "K1" },
      disposition: "confirmed",
      checkedAt: now,
      origin: "manual",
    });
    expect(
      foldOutcome(
        { tool: "todoist.create_task", status: "ok", output: { id: "K1" } },
        settled,
        { now, windowMs: WINDOW, outcomeStore: store },
      ),
    ).toEqual({ fold: true, good: true });
  });

  it("a failure is still a failure, not a withhold", () => {
    expect(
      foldOutcome({ tool: "http.post", status: "error" }, settled, {
        now,
        windowMs: WINDOW,
        outcomeStore: new OutcomeStore(dir),
      }),
    ).toEqual({ fold: true, good: false });
  });
});
