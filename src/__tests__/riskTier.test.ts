/**
 * classifyTool tiering — including the namespaced recipe-tool-id fix.
 *
 * Bug (M3, audit follow-up): `classifyTool` / `inferTierFromName` were written
 * for camelCase MCP tool names (gitPush, githubCreatePR) and had no handling
 * for the namespaced `namespace.verb` recipe tool ids (github.list_issues,
 * slack.post_message, jira.get_issue, …). Every namespaced id fell through to
 * the uniform "medium" default — so connector READS were over-tiered and the
 * approval gate's tier disagreed with the simulation/registry (riskDefault).
 *
 * The fix: (1) an authoritative resolver hook the recipe tool registry
 * populates with each tool's `riskDefault`, and (2) a namespaced heuristic
 * fallback (read verbs → low, write verbs → medium) that matches the registry's
 * `isWrite ? medium : low` convention when the registry isn't loaded.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  classifyTool,
  type RiskTier,
  registerTierResolver,
} from "../riskTier.js";

afterEach(() => {
  // Clear any resolver a test installed so cases don't leak into each other.
  registerTierResolver(null);
});

describe("classifyTool — camelCase MCP names (unchanged)", () => {
  it("keeps known high/medium/low MCP tools", () => {
    expect(classifyTool("gitPush")).toBe("high");
    expect(classifyTool("editText")).toBe("medium");
    expect(classifyTool("getDiagnostics")).toBe("low");
  });
});

describe("classifyTool — namespaced recipe tool ids (the bug)", () => {
  it("classifies connector READS as low, not the uniform medium default", () => {
    expect(classifyTool("github.list_issues")).toBe("low");
    expect(classifyTool("jira.get_issue")).toBe("low");
    expect(classifyTool("gmail.search")).toBe("low");
    expect(classifyTool("datadog.list_monitors")).toBe("low");
  });

  it("classifies connector WRITES as medium (matches registry convention)", () => {
    expect(classifyTool("slack.post_message")).toBe("medium");
    expect(classifyTool("jira.create_issue")).toBe("medium");
    expect(classifyTool("http.post")).toBe("medium");
    expect(classifyTool("sendgrid.send_email")).toBe("medium");
  });

  it("defaults an unrecognized namespaced verb to medium (safe)", () => {
    expect(classifyTool("weird.frobnicate")).toBe("medium");
  });
});

describe("classifyTool — authoritative resolver hook", () => {
  it("uses the registered resolver's riskDefault for namespaced ids", () => {
    const table: Record<string, RiskTier> = {
      "github.list_issues": "low",
      "custom.escalate": "high", // registry could mark a tool high
    };
    registerTierResolver((id) => table[id]);
    expect(classifyTool("custom.escalate")).toBe("high");
    expect(classifyTool("github.list_issues")).toBe("low");
  });

  it("falls back to the heuristic when the resolver returns undefined", () => {
    registerTierResolver(() => undefined);
    expect(classifyTool("github.list_issues")).toBe("low");
    expect(classifyTool("slack.post_message")).toBe("medium");
  });

  it("does not consult the resolver for non-namespaced names", () => {
    let called = false;
    registerTierResolver((_id) => {
      called = true;
      return "high";
    });
    expect(classifyTool("getDiagnostics")).toBe("low");
    expect(called).toBe(false);
  });
});
