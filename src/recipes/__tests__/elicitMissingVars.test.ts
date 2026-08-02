/**
 * #1217 — inline prompting for a recipe's missing required vars.
 *
 * The invariant every test here defends: this path may only ever ADD values a
 * human typed. Any other outcome must leave the caller's existing
 * `missing_required_vars` halt untouched.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildMissingVarsMessage,
  buildMissingVarsSchema,
  elicitMissingVars,
} from "../elicitMissingVars.js";

const DECLS = [
  { name: "repo", description: "owner/name to file against" },
  { name: "team" },
];

describe("buildMissingVarsSchema", () => {
  it("marks every prompted var required", () => {
    // An optional property would let a client return an 'accept' with the var
    // still absent, which downstream reads as answered.
    const schema = buildMissingVarsSchema(DECLS);
    expect(schema.required).toEqual(["repo", "team"]);
    expect(schema.type).toBe("object");
  });

  it("carries the recipe author's description through when there is one", () => {
    const props = buildMissingVarsSchema(DECLS).properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.repo).toEqual({
      type: "string",
      description: "owner/name to file against",
    });
    expect(props.team).toEqual({ type: "string" });
  });
});

describe("buildMissingVarsMessage", () => {
  it("names the recipe and the vars", () => {
    const msg = buildMissingVarsMessage("triage", DECLS);
    expect(msg).toContain("triage");
    expect(msg).toContain("repo, team");
  });
});

describe("elicitMissingVars", () => {
  it("returns the values the user supplied on accept", async () => {
    const elicit = vi.fn().mockResolvedValue({
      action: "accept",
      content: { repo: "Oolab-labs/patchwork-os", team: "Engineering" },
    });
    await expect(
      elicitMissingVars({ recipeName: "triage", declarations: DECLS, elicit }),
    ).resolves.toEqual({
      repo: "Oolab-labs/patchwork-os",
      team: "Engineering",
    });
  });

  it("returns nothing when the user declines", async () => {
    const elicit = vi.fn().mockResolvedValue({ action: "decline" });
    await expect(
      elicitMissingVars({ recipeName: "triage", declarations: DECLS, elicit }),
    ).resolves.toEqual({});
  });

  it("returns nothing when the user cancels", async () => {
    const elicit = vi.fn().mockResolvedValue({ action: "cancel" });
    await expect(
      elicitMissingVars({ recipeName: "triage", declarations: DECLS, elicit }),
    ).resolves.toEqual({});
  });

  it("swallows a rejected elicit (no client / timeout) rather than throwing", async () => {
    // The caller's halt is the fallback; an exception here would turn a clean
    // 'missing_required_vars' into an unhandled failure.
    const onWarn = vi.fn();
    const elicit = vi
      .fn()
      .mockRejectedValue(new Error("No active MCP client connected"));
    await expect(
      elicitMissingVars({
        recipeName: "triage",
        declarations: DECLS,
        elicit,
        onWarn,
      }),
    ).resolves.toEqual({});
    expect(onWarn).toHaveBeenCalledOnce();
  });

  it("drops blank and whitespace-only answers", async () => {
    // The required-vars check treats whitespace as missing, so accepting one
    // here would only fail the caller's recheck a line later.
    const elicit = vi.fn().mockResolvedValue({
      action: "accept",
      content: { repo: "   ", team: "Engineering" },
    });
    await expect(
      elicitMissingVars({ recipeName: "triage", declarations: DECLS, elicit }),
    ).resolves.toEqual({ team: "Engineering" });
  });

  it("drops non-string answers", async () => {
    const elicit = vi.fn().mockResolvedValue({
      action: "accept",
      content: { repo: 42, team: null },
    });
    await expect(
      elicitMissingVars({ recipeName: "triage", declarations: DECLS, elicit }),
    ).resolves.toEqual({});
  });

  it("ignores keys it never asked for", async () => {
    // A client answering with extra keys must not be able to inject vars the
    // recipe never declared into the run context.
    const elicit = vi.fn().mockResolvedValue({
      action: "accept",
      content: { repo: "a/b", team: "T", GITHUB_TOKEN: "leaked" },
    });
    const out = await elicitMissingVars({
      recipeName: "triage",
      declarations: DECLS,
      elicit,
    });
    expect(out).toEqual({ repo: "a/b", team: "T" });
    expect(out).not.toHaveProperty("GITHUB_TOKEN");
  });

  it("does not call the client at all when nothing is missing", async () => {
    const elicit = vi.fn();
    await expect(
      elicitMissingVars({ recipeName: "triage", declarations: [], elicit }),
    ).resolves.toEqual({});
    expect(elicit).not.toHaveBeenCalled();
  });

  it("tolerates a bare content object from a client that omits `action`", async () => {
    const elicit = vi.fn().mockResolvedValue({ repo: "a/b", team: "T" });
    await expect(
      elicitMissingVars({ recipeName: "triage", declarations: DECLS, elicit }),
    ).resolves.toEqual({ repo: "a/b", team: "T" });
  });

  it("returns nothing for a non-object result", async () => {
    const elicit = vi.fn().mockResolvedValue("ok");
    await expect(
      elicitMissingVars({ recipeName: "triage", declarations: DECLS, elicit }),
    ).resolves.toEqual({});
  });
});
