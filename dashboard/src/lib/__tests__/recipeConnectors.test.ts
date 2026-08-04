/**
 * Regression: `detectConnectorsForRecipe` matched connector namespaces by naive
 * substring, so the two-letter alias `es` (elasticsearch) hit the letters "es"
 * inside ordinary English — "does", "files", "causes", "assembles". On a real
 * install that made 63 of 73 recipes report "It needs Elasticsearch connected
 * before it can run", with a Connect button leading to a setup task that did
 * not exist.
 *
 * A FALSE required-connector is worse than a missed one: it blocks a working
 * recipe behind imaginary setup. These pin whole-token matching.
 */

import { describe, expect, it } from "vitest";
import { detectConnectorsForRecipe } from "../recipeConnectors";

describe("detectConnectorsForRecipe — no substring false positives", () => {
  it("does not infer elasticsearch from ordinary English containing 'es'", () => {
    const recipe = {
      name: "month-end-exception-review",
      description:
        "It does not post anything. The recipe reads both evidence files and " +
        "assembles the memo, decomposing causes by type.",
    };
    expect(detectConnectorsForRecipe(recipe)).not.toContain("elasticsearch");
  });

  it.each([
    ["does", "it does not post anything"],
    ["files", "reads both evidence files"],
    ["causes", "decomposing causes by type"],
    ["assembles", "assembles the memo"],
    ["notes", "release notes for the period"],
  ])("'%s' does not trigger elasticsearch", (_word, description) => {
    expect(
      detectConnectorsForRecipe({ name: "r", description }),
    ).not.toContain("elasticsearch");
  });

  it("still detects a genuine `es` namespace as a whole token", () => {
    expect(
      detectConnectorsForRecipe({ name: "r", description: "queries es for logs" }),
    ).toContain("elasticsearch");
  });

  it("still detects a full connector id by name", () => {
    expect(
      detectConnectorsForRecipe({
        name: "log-search",
        description: "reads from elasticsearch",
      }),
    ).toContain("elasticsearch");
  });

  it("detects hyphenated connector ids (regex-escaped)", () => {
    expect(
      detectConnectorsForRecipe({
        name: "r",
        description: "syncs with google-calendar each morning",
      }),
    ).toContain("google-calendar");
  });

  it("does not infer a connector from a word merely containing its id", () => {
    // "slackness" contains "slack"; a token match must not fire.
    expect(
      detectConnectorsForRecipe({ name: "r", description: "reviews slackness" }),
    ).not.toContain("slack");
  });

  it("returns nothing for a recipe that names no connector", () => {
    expect(
      detectConnectorsForRecipe({
        name: "month-end-exception-review",
        description: "reads a local csv and writes a memo to the inbox",
      }),
    ).toEqual([]);
  });
});
