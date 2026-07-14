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

describe("parseCopilotIntent — ambiguous_recipe", () => {
  it("returns ambiguous_recipe when two distinct recipes tie for the longest match", () => {
    const recipes = [
      { name: "foo-bar", enabled: true },
      { name: "baz-qux", enabled: true },
    ];
    const intent = parseCopilotIntent("pause foo-bar or baz-qux", recipes);
    expect(intent.kind).toBe("ambiguous_recipe");
    if (intent.kind === "ambiguous_recipe") {
      expect(intent.candidates.map((c) => c.name).sort()).toEqual([
        "baz-qux",
        "foo-bar",
      ]);
    }
  });

  it("does not flag ambiguity when one match is strictly longer", () => {
    const recipes = [
      { name: "ingest", enabled: true },
      { name: "outcome-ingester", enabled: true },
    ];
    // Both names are substrings of the text, but "outcome-ingester" is
    // longer, so it wins outright rather than being flagged ambiguous.
    const intent = parseCopilotIntent(
      "run outcome-ingester not just ingest",
      recipes,
    );
    expect(intent).toEqual({
      kind: "run_recipe",
      recipe: { name: "outcome-ingester", enabled: true },
    });
  });

  it("takes ambiguity precedence over halt-explanation phrasing", () => {
    const recipes = [
      { name: "foo-bar", enabled: true },
      { name: "baz-qux", enabled: true },
    ];
    const intent = parseCopilotIntent(
      "why did foo-bar or baz-qux halt",
      recipes,
    );
    expect(intent.kind).toBe("ambiguous_recipe");
  });
});

describe("parseCopilotIntent — read-only status Q&A", () => {
  it.each([
    "how many approvals pending",
    "approvals?",
    "any approval left",
  ])("recognizes %s as approvals_status", (text) => {
    expect(parseCopilotIntent(text, RECIPES)).toEqual({
      kind: "approvals_status",
    });
  });

  it.each([
    "kill switch status",
    "is the killswitch engaged",
    "kill-switch?",
  ])("recognizes %s as kill_switch_status", (text) => {
    expect(parseCopilotIntent(text, RECIPES)).toEqual({
      kind: "kill_switch_status",
    });
  });

  it("kill-switch pattern doesn't collide with the pause pattern's bare 'kill'", () => {
    const intent = parseCopilotIntent("kill nightly-review", RECIPES);
    expect(intent).toEqual({
      kind: "pause_recipe",
      recipe: { name: "nightly-review", enabled: true },
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

  it("proposes a create_recipe card for a recipe-creation goal", () => {
    const intent = parseCopilotIntent(
      "create a recipe that posts failed deploys to slack",
      RECIPES,
    );
    expect(intent).toEqual({
      kind: "create_recipe",
      goal: "create a recipe that posts failed deploys to slack",
    });
    const result = buildCopilotReply(intent);
    expect(result.action).toEqual({
      kind: "create_recipe",
      recipeName: "",
      goal: "create a recipe that posts failed deploys to slack",
    });
  });

  it("proposes a create_worker card for a worker-creation goal, distinct from create_recipe", () => {
    const intent = parseCopilotIntent(
      "build a worker that reviews PRs",
      RECIPES,
    );
    expect(intent).toEqual({
      kind: "create_worker",
      goal: "build a worker that reviews PRs",
    });
    const result = buildCopilotReply(intent);
    expect(result.action?.kind).toBe("create_worker");
    expect(result.reply).toMatch(
      /owns.*autonomy ceiling|autonomy ceiling.*owns/i,
    );
  });

  it("does not mistake a creation goal naming an existing recipe for a lever action", () => {
    // "nightly-review" is installed, but "create a recipe" should win over
    // treating this as a mention of the existing recipe.
    const intent = parseCopilotIntent(
      "create a recipe similar to nightly-review but for weekly summaries",
      RECIPES,
    );
    expect(intent.kind).toBe("create_recipe");
  });

  it("asks for disambiguation without proposing an action", () => {
    const result = buildCopilotReply({
      kind: "ambiguous_recipe",
      candidates: [
        { name: "foo-bar", enabled: true },
        { name: "baz-qux", enabled: true },
      ],
    });
    expect(result.action).toBeUndefined();
    expect(result.reply).toMatch(/"foo-bar"/);
    expect(result.reply).toMatch(/"baz-qux"/);
  });

  it("reports zero approvals pending", () => {
    const result = buildCopilotReply(
      { kind: "approvals_status" },
      { approvalsPending: 0 },
    );
    expect(result.reply).toMatch(/no approvals pending/i);
    expect(result.action).toBeUndefined();
  });

  it("reports a nonzero approvals count with correct pluralization", () => {
    expect(
      buildCopilotReply({ kind: "approvals_status" }, { approvalsPending: 1 })
        .reply,
    ).toMatch(/1 approval pending/i);
    expect(
      buildCopilotReply({ kind: "approvals_status" }, { approvalsPending: 3 })
        .reply,
    ).toMatch(/3 approvals pending/i);
  });

  it("reports kill-switch engaged vs released", () => {
    expect(
      buildCopilotReply(
        { kind: "kill_switch_status" },
        { killSwitchEngaged: true },
      ).reply,
    ).toMatch(/engaged/i);
    expect(
      buildCopilotReply(
        { kind: "kill_switch_status" },
        { killSwitchEngaged: false },
      ).reply,
    ).toMatch(/released/i);
  });
});
