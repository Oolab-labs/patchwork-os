/**
 * agent.downshift validation — cost-routing Phase 4. Each entry must set at
 * least one of {driver, model}, and any driver must be dispatch-known.
 */
import { describe, expect, it } from "vitest";
import { validateRecipeDefinition } from "../validation.js";

function agentErrors(extra: Record<string, unknown>): string {
  const r = validateRecipeDefinition({
    name: "d",
    version: "1.0.0",
    trigger: { type: "manual" },
    steps: [{ id: "s", agent: { prompt: "hi", ...extra } }],
  });
  return r.issues
    .filter((i) => i.level === "error")
    .map((i) => i.message)
    .join(" | ");
}

describe("agent.downshift validation", () => {
  it("accepts a valid downshift list", () => {
    expect(
      agentErrors({
        downshift: [{ model: "cheap" }, { driver: "local", model: "llama3" }],
      }),
    ).toBe("");
  });

  it("accepts a driver-only and a model-only entry", () => {
    expect(
      agentErrors({ downshift: [{ driver: "openai" }, { model: "x" }] }),
    ).toBe("");
  });

  it("rejects a non-array downshift", () => {
    expect(agentErrors({ downshift: "cheap" })).toMatch(
      /'downshift' must be an array/,
    );
  });

  it("rejects a non-object entry", () => {
    expect(agentErrors({ downshift: ["cheap"] })).toMatch(/must be an object/);
  });

  it("rejects an empty entry (no driver or model)", () => {
    expect(agentErrors({ downshift: [{}] })).toMatch(
      /at least one of 'driver' or 'model'/,
    );
  });

  it("rejects an unknown driver", () => {
    expect(
      agentErrors({ downshift: [{ driver: "telepathy", model: "x" }] }),
    ).toMatch(/not a known driver/);
  });
});

describe("agent.escalate validation (quality-aware, shares the route-list helper)", () => {
  it("accepts a valid escalate list", () => {
    expect(
      agentErrors({
        escalate: [{ model: "claude-opus-4-8" }, { driver: "anthropic" }],
      }),
    ).toBe("");
  });

  it("rejects a non-array escalate", () => {
    expect(agentErrors({ escalate: "opus" })).toMatch(
      /'escalate' must be an array/,
    );
  });

  it("rejects an empty entry", () => {
    expect(agentErrors({ escalate: [{}] })).toMatch(
      /at least one of 'driver' or 'model'/,
    );
  });

  it("rejects an unknown driver", () => {
    expect(agentErrors({ escalate: [{ driver: "telepathy" }] })).toMatch(
      /not a known driver/,
    );
  });
});
