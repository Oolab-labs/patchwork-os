import { describe, expect, it } from "vitest";
import { buildCopilotReply, parseCopilotIntent } from "../parseIntent.js";

const RECIPES = [
  { name: "nightly-review", enabled: true },
  { name: "outcome-ingester", enabled: true },
  { name: "morning-brief", enabled: false },
];

describe("parseCopilotIntent — pause", () => {
  it.each([
    "pause nightly-review",
    "pause nightly review",
    "PAUSE Nightly-Review",
    "disable nightly-review, it's too noisy this week",
    "stop nightly-review",
    "kill nightly-review",
  ])("recognizes %s", (text) => {
    const intent = parseCopilotIntent(text, RECIPES);
    expect(intent).toEqual({
      kind: "pause_recipe",
      recipe: { name: "nightly-review", enabled: true },
    });
  });
});

describe("parseCopilotIntent — enable", () => {
  it.each([
    "enable morning-brief",
    "resume morning-brief",
    "unpause morning-brief",
    "re-enable morning-brief",
    "turn on morning-brief",
  ])("recognizes %s", (text) => {
    const intent = parseCopilotIntent(text, RECIPES);
    expect(intent).toEqual({
      kind: "enable_recipe",
      recipe: { name: "morning-brief", enabled: false },
    });
  });
});

describe("parseCopilotIntent — run", () => {
  it.each([
    "run outcome-ingester",
    "start outcome-ingester",
    "trigger outcome-ingester now",
    "kick off outcome-ingester",
    "fire outcome-ingester",
  ])("recognizes %s", (text) => {
    const intent = parseCopilotIntent(text, RECIPES);
    expect(intent).toEqual({
      kind: "run_recipe",
      recipe: { name: "outcome-ingester", enabled: true },
    });
  });
});

describe("parseCopilotIntent — explain_halt", () => {
  it("recognizes a halt question naming a recipe", () => {
    const intent = parseCopilotIntent("why did outcome-ingester halt", RECIPES);
    expect(intent).toEqual({
      kind: "explain_halt",
      recipe: { name: "outcome-ingester", enabled: true },
    });
  });

  it("recognizes a halt question with no recipe named", () => {
    const intent = parseCopilotIntent("why did that halt", RECIPES);
    expect(intent).toEqual({ kind: "explain_halt" });
  });

  it("recognizes 'explain the halt' phrasing", () => {
    const intent = parseCopilotIntent(
      "explain the outcome-ingester halt",
      RECIPES,
    );
    expect(intent.kind).toBe("explain_halt");
  });

  it("prefers halt-explanation over the pause pattern's 'stop' keyword", () => {
    // "halted" contains no pause-verb, but a naive implementation checking
    // pause before halt could misfire on phrasings mixing both ideas.
    const intent = parseCopilotIntent(
      "why is outcome-ingester stopped / halted",
      RECIPES,
    );
    expect(intent.kind).toBe("explain_halt");
  });
});

describe("parseCopilotIntent — ambiguous / no match", () => {
  it("returns unrecognized for text with no recognizable verb", () => {
    const intent = parseCopilotIntent("what's the weather like", RECIPES);
    expect(intent).toEqual({
      kind: "unrecognized",
      text: "what's the weather like",
    });
  });

  it("returns unrecognized for an action verb with no matching recipe name", () => {
    const intent = parseCopilotIntent(
      "pause the thing that isn't installed",
      RECIPES,
    );
    expect(intent.kind).toBe("unrecognized");
  });

  it("returns unrecognized for empty input", () => {
    expect(parseCopilotIntent("", RECIPES)).toEqual({
      kind: "unrecognized",
      text: "",
    });
    expect(parseCopilotIntent("   ", RECIPES)).toEqual({
      kind: "unrecognized",
      text: "   ",
    });
  });

  it("prefers the longest matching recipe name (no false-positive short match)", () => {
    const recipes = [
      { name: "ingest", enabled: true },
      { name: "outcome-ingester", enabled: true },
    ];
    const intent = parseCopilotIntent("run outcome-ingester", recipes);
    expect(intent).toEqual({
      kind: "run_recipe",
      recipe: { name: "outcome-ingester", enabled: true },
    });
  });
});

describe("buildCopilotReply", () => {
  it("proposes a pause_recipe action card", () => {
    const result = buildCopilotReply({
      kind: "pause_recipe",
      recipe: { name: "nightly-review", enabled: true },
    });
    expect(result.action).toEqual({
      kind: "pause_recipe",
      recipeName: "nightly-review",
    });
    expect(result.reply).toMatch(/nightly-review/);
  });

  it("proposes an enable_recipe action card", () => {
    const result = buildCopilotReply({
      kind: "enable_recipe",
      recipe: { name: "morning-brief", enabled: false },
    });
    expect(result.action).toEqual({
      kind: "enable_recipe",
      recipeName: "morning-brief",
    });
  });

  it("proposes a run_recipe action card", () => {
    const result = buildCopilotReply({
      kind: "run_recipe",
      recipe: { name: "outcome-ingester", enabled: true },
    });
    expect(result.action).toEqual({
      kind: "run_recipe",
      recipeName: "outcome-ingester",
    });
  });

  it("never proposes an action for explain_halt (read-only)", () => {
    const result = buildCopilotReply(
      {
        kind: "explain_halt",
        recipe: { name: "outcome-ingester", enabled: true },
      },
      { haltReason: "github.search_issues: HTTP 401" },
    );
    expect(result.action).toBeUndefined();
    expect(result.reply).toMatch(/HTTP 401/);
  });

  it("gives a no-halt-found reply when there's no reason on record", () => {
    const result = buildCopilotReply({
      kind: "explain_halt",
      recipe: { name: "outcome-ingester", enabled: true },
    });
    expect(result.reply).toMatch(/don't see a recent halt/i);
  });

  it("falls back to the can-do hint for unrecognized text", () => {
    const result = buildCopilotReply({
      kind: "unrecognized",
      text: "what's up",
    });
    expect(result.action).toBeUndefined();
    expect(result.reply).toMatch(/pause, enable, or run/i);
  });

  it("gives an honest deferred-feature reply for recipe/worker creation asks", () => {
    const result = buildCopilotReply({
      kind: "unrecognized",
      text: "create a recipe that posts failed deploys to slack",
    });
    expect(result.reply).toMatch(/isn't wired up yet/i);
    expect(result.action).toBeUndefined();
  });
});
