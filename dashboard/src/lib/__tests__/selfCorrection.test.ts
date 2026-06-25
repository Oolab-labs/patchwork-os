import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ESCALATE_LADDER,
  DEFAULT_MAX_REVISIONS,
  enableSelfCorrection,
} from "../selfCorrection";

const RECIPE = `name: demo
trigger:
  type: manual
steps:
  - tool: git.log_since
    into: commits
  - agent:
      prompt: Summarize the commits
    into: summary
`;

interface Step {
  id?: string;
  into?: string;
  kind?: string;
  reviews?: string;
  max_revisions?: number;
  on_exhausted?: string;
  escalate?: Array<{ model?: string; driver?: string }>;
  agent?: { prompt?: string };
}

function steps(yaml: string): Step[] {
  return (parse(yaml) as { steps: Step[] }).steps;
}

describe("enableSelfCorrection", () => {
  it("adds a judge step + escalate ladder to the last agent step", () => {
    const { yaml, changed, message } = enableSelfCorrection(RECIPE);
    expect(changed).toBe(true);
    expect(message).toMatch(/self-correction judge for "summary"/);

    const s = steps(yaml);
    // git step + agent step + inserted judge = 3
    expect(s).toHaveLength(3);

    const agent = s.find((x) => x.into === "summary")!;
    expect(agent.escalate).toEqual([...DEFAULT_ESCALATE_LADDER]);

    const judge = s.find((x) => x.kind === "judge")!;
    expect(judge.reviews).toBe("summary");
    expect(judge.max_revisions).toBe(DEFAULT_MAX_REVISIONS);
    expect(judge.on_exhausted).toBe("proceed");
    expect(judge.agent?.prompt).toBeTruthy();
    // judge is inserted immediately AFTER the reviewed step
    expect(s.indexOf(judge)).toBe(s.indexOf(agent) + 1);
  });

  it("escalate ladder is model-only (driver-agnostic, safe for any setup)", () => {
    const s = steps(enableSelfCorrection(RECIPE).yaml);
    const agent = s.find((x) => x.into === "summary")!;
    for (const rung of agent.escalate!) {
      expect(rung.model).toBeTruthy();
      expect(rung.driver).toBeUndefined();
    }
  });

  it("targets a specific agent step by id/into when given", () => {
    const multi = `name: m
trigger: { type: manual }
steps:
  - agent: { prompt: a }
    into: first
  - agent: { prompt: b }
    into: second
`;
    const s = steps(enableSelfCorrection(multi, "first").yaml);
    const judge = s.find((x) => x.kind === "judge")!;
    expect(judge.reviews).toBe("first");
    // inserted right after "first", before "second"
    expect(s.map((x) => x.into ?? x.kind)).toEqual([
      "first",
      "judge",
      "second",
    ]);
  });

  it("is idempotent — no second judge for an already-corrected step", () => {
    const once = enableSelfCorrection(RECIPE).yaml;
    const twice = enableSelfCorrection(once);
    expect(twice.changed).toBe(false);
    expect(twice.message).toMatch(/already has a self-correction judge/);
    expect(steps(twice.yaml).filter((x) => x.kind === "judge")).toHaveLength(1);
  });

  it("keeps an existing escalate ladder instead of clobbering it", () => {
    const withLadder = `name: x
trigger: { type: manual }
steps:
  - agent: { prompt: a }
    into: out
    escalate:
      - model: my-custom-model
`;
    const { yaml, message } = enableSelfCorrection(withLadder);
    const agent = steps(yaml).find((x) => x.into === "out")!;
    expect(agent.escalate).toEqual([{ model: "my-custom-model" }]);
    expect(message).toMatch(/existing escalation ladder/);
  });

  it("no-ops on a recipe with no agent step", () => {
    const toolsOnly = `name: t
trigger: { type: manual }
steps:
  - tool: git.log_since
    into: commits
`;
    const r = enableSelfCorrection(toolsOnly);
    expect(r.changed).toBe(false);
    expect(r.message).toMatch(/No agent step/);
    expect(r.yaml).toBe(toolsOnly);
  });

  it("no-ops (does not throw) on unparseable YAML", () => {
    const bad = "name: x\n  steps: [oops";
    const r = enableSelfCorrection(bad);
    expect(r.changed).toBe(false);
    expect(r.yaml).toBe(bad);
  });
});
