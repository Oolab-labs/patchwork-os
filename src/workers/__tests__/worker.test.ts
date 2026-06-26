import { describe, expect, it } from "vitest";
import { classifyActionClass } from "../actionClass.js";
import { DEFAULT_PRIOR, posteriorMean } from "../trustLevel.js";
import {
  ownsAction,
  parseWorker,
  priorFor,
  WorkerParseError,
} from "../worker.js";

describe("parseWorker", () => {
  it("parses a full manifest", () => {
    const w = parseWorker({
      id: "release-bot",
      name: "Release Worker",
      responsibilities: ["draft release notes"],
      recipe: "release-notes",
      owns: ["vcs-read", "fs-write"],
      autonomyCeiling: 3,
      competence: { mean: 0.9, strength: 4 },
      sector: "engineering",
    });
    expect(w.id).toBe("release-bot");
    expect(w.autonomyCeiling).toBe(3);
    expect(w.owns).toEqual(["vcs-read", "fs-write"]);
  });

  it("defaults autonomyCeiling to 4 (uncapped) and owns to []", () => {
    const w = parseWorker({ id: "w", name: "W" });
    expect(w.autonomyCeiling).toBe(4);
    expect(w.owns).toEqual([]);
    expect(w.competence).toBeUndefined();
  });

  it("rejects a non-kebab id, an out-of-range ceiling, and a bad competence mean", () => {
    expect(() => parseWorker({ id: "Bad Id", name: "x" })).toThrow(
      WorkerParseError,
    );
    expect(() =>
      parseWorker({ id: "w", name: "x", autonomyCeiling: 5 }),
    ).toThrow(WorkerParseError);
    expect(() =>
      parseWorker({ id: "w", name: "x", competence: { mean: 2, strength: 4 } }),
    ).toThrow(WorkerParseError);
  });
});

describe("priorFor", () => {
  it("returns the uniform prior with no competence claim", () => {
    expect(priorFor(parseWorker({ id: "w", name: "W" }))).toEqual(
      DEFAULT_PRIOR,
    );
  });

  it("encodes a competence claim as the prior mean", () => {
    const p = priorFor(
      parseWorker({
        id: "w",
        name: "W",
        competence: { mean: 0.9, strength: 4 },
      }),
    );
    expect(posteriorMean(p)).toBeCloseTo(0.9, 2);
  });
});

describe("ownsAction", () => {
  const w = parseWorker({
    id: "w",
    name: "W",
    owns: ["vcs-local", "fs-write:reversible:medium"],
  });

  it("matches by domain, exact key, and prefix; rejects unowned", () => {
    expect(ownsAction(w, classifyActionClass("gitCommit"))).toBe(true); // vcs-local domain
    expect(ownsAction(w, classifyActionClass("editText"))).toBe(true); // exact key
    expect(ownsAction(w, classifyActionClass("slackPostMessage"))).toBe(false);
  });

  it("a worker owning nothing matches nothing", () => {
    const empty = parseWorker({ id: "e", name: "E" });
    expect(ownsAction(empty, classifyActionClass("editText"))).toBe(false);
  });
});
