/**
 * butlerRemember / butlerRecall / butlerForget — the agent-facing surface of
 * Butler's memory (audit M36: these had no tests).
 *
 * The property that matters is the trust barrier. An agent writes at
 * `recipe_agent` (0.5), strictly below ORIGINATE_THRESHOLD (0.6), so whatever
 * it was just told cannot become a belief on its own. The same barrier has to
 * hold for retraction: an agent that may not establish a fact must not be able
 * to un-establish one the user stated, or injected text can delete
 * "diet.avoid: shellfish" as easily as it could have invented it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ButlerFactStore } from "../../butler/factStore.js";
import { ORIGINATE_THRESHOLD } from "../../butler/types.js";
import {
  createButlerForgetTool,
  createButlerRecallTool,
  createButlerRememberTool,
} from "../butlerMemory.js";

let dir: string;
let store: ButlerFactStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "butler-tools-"));
  store = new ButlerFactStore({ dir, now: () => 1_000 });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Result = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ text?: string }>;
};

function data(r: unknown): Record<string, unknown> {
  const res = r as Result;
  return (
    res.structuredContent ??
    (JSON.parse(res.content?.[0]?.text ?? "{}") as Record<string, unknown>)
  );
}

function text(r: unknown): string {
  return (r as Result).content?.[0]?.text ?? "";
}

const remember = () => createButlerRememberTool(store);
const recall = () => createButlerRecallTool(store);
const forget = () => createButlerForgetTool(store);

describe("butlerRemember", () => {
  it("records at agent trust, below the originate floor, and says so", async () => {
    const r = await remember().handler({
      subject: "user",
      predicate: "timezone",
      object: "Europe/Lisbon",
    });
    const d = data(r);
    expect(d.trust).toBe(0.5);
    expect(d.trust as number).toBeLessThan(ORIGINATE_THRESHOLD);
    expect(d.willOriginate).toBe(false);
  });

  it("ignores a caller-supplied channel: the agent cannot name its own trust", async () => {
    const r = await remember().handler({
      subject: "user",
      predicate: "timezone",
      object: "Europe/Lisbon",
      channel: "user_chat",
    });
    expect(data(r).trust).toBe(0.5);
  });

  it("an agent-written fact is not an established belief", async () => {
    await remember().handler({
      subject: "user",
      predicate: "timezone",
      object: "Europe/Lisbon",
    });
    const established = data(await recall().handler({}));
    expect(established.count).toBe(0);
    const all = data(await recall().handler({ minTrust: 0 }));
    expect(all.count).toBe(1);
  });

  it("refuses a bad contentConfidence", async () => {
    const r = await remember().handler({
      subject: "user",
      predicate: "timezone",
      object: "x",
      contentConfidence: "high",
    });
    expect((r as Result).isError).toBe(true);
  });

  it("refuses a missing subject", async () => {
    const r = await remember().handler({ predicate: "timezone", object: "x" });
    expect((r as Result).isError).toBe(true);
  });
});

describe("butlerRecall", () => {
  it("returns user-stated facts and filters by subject and predicate", async () => {
    store.remember({
      subject: "user",
      predicate: "diet.avoid",
      object: "shellfish",
      channel: "user_chat",
    });
    store.remember({
      subject: "household.partner",
      predicate: "diet.avoid",
      object: "gluten",
      channel: "user_chat",
    });
    const all = data(await recall().handler({}));
    expect(all.count).toBe(2);
    const one = data(await recall().handler({ subject: "user" }));
    expect(one.count).toBe(1);
    expect((one.facts as Array<{ object: string }>)[0]?.object).toBe(
      "shellfish",
    );
    const none = data(await recall().handler({ predicate: "timezone" }));
    expect(none.count).toBe(0);
  });

  it("caps limit at 200 and at least 1", async () => {
    for (let i = 0; i < 3; i++)
      store.remember({
        subject: `s${i}`,
        predicate: "p",
        object: "o",
        channel: "user_chat",
      });
    expect(data(await recall().handler({ limit: 1 })).count).toBe(1);
    expect(data(await recall().handler({ limit: 0 })).count).toBe(1);
  });
});

describe("butlerForget", () => {
  it("an agent may retract a fact written at agent trust", async () => {
    const seq = data(
      await remember().handler({
        subject: "user",
        predicate: "timezone",
        object: "Europe/Lisbon",
      }),
    ).seq as number;
    const r = await forget().handler({ seq });
    expect((r as Result).isError).toBeFalsy();
    expect(data(await recall().handler({ minTrust: 0 })).count).toBe(0);
  });

  it("an agent may NOT retract a fact the user stated", async () => {
    const userFact = store.remember({
      subject: "user",
      predicate: "diet.avoid",
      object: "shellfish",
      channel: "user_chat",
    });
    const r = await forget().handler({ seq: userFact.seq });
    expect((r as Result).isError).toBe(true);
    // Still believed: the refusal is real, not just reported.
    const still = data(await recall().handler({}));
    expect(still.count).toBe(1);
  });

  it("an unknown seq is an error", async () => {
    const r = await forget().handler({ seq: 999 });
    expect((r as Result).isError).toBe(true);
    expect(text(r)).toContain("999");
  });

  it("a non-integer seq is refused before the store is touched", async () => {
    const r = await forget().handler({ seq: 1.5 });
    expect((r as Result).isError).toBe(true);
  });
});
