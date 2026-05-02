/**
 * A-PR2 — `parseGithubShorthand` strict validation tests (dogfood R2 M-2).
 *
 * Owner/repo segments validated against GitHub's username/repo rules
 * (`/^[a-zA-Z0-9](?:[a-zA-Z0-9-._]{0,38})$/`); subdir segments required
 * to clear `isSafeBasename`; refs forbid `@:?#` etc.
 *
 * Pre-existing happy-path coverage lives in `recipeInstall.test.ts`; this
 * file is a focused regression suite for the injection cases that prompted
 * the rewrite.
 */

import { describe, expect, it } from "vitest";
import { parseInstallSource } from "../recipeInstall.js";

describe("parseGithubShorthand — A-PR2 strict validation (R2 M-2)", () => {
  it("rejects gh:foo@bar:bad/repo (port-injection style)", () => {
    // The `:bad` segment is part of `bar:bad` which is consumed as the ref
    // (`@bar:bad/repo`). Ref contains `:` → reject.
    expect(() => parseInstallSource("gh:foo/repo@bar:bad")).toThrow(
      /disallowed characters/,
    );
  });

  it("rejects owners with disallowed characters", () => {
    expect(() => parseInstallSource("gh:foo!bar/repo")).toThrow(
      /not a valid GitHub username/,
    );
    expect(() => parseInstallSource("gh:foo bar/repo")).toThrow(
      /not a valid GitHub username/,
    );
    expect(() => parseInstallSource("gh:-leading-dash/repo")).toThrow(
      /not a valid GitHub username/,
    );
  });

  it("rejects repos with disallowed characters", () => {
    expect(() => parseInstallSource("gh:owner/<script>")).toThrow(
      /not a valid GitHub repository/,
    );
    expect(() => parseInstallSource("gh:owner/repo?evil=1")).toThrow(
      /not a valid GitHub repository/,
    );
  });

  it("rejects subdir traversal segments", () => {
    expect(() => parseInstallSource("gh:owner/repo/../etc")).toThrow(/unsafe/);
    expect(() => parseInstallSource("gh:owner/repo/.")).toThrow(/unsafe/);
  });

  it("rejects refs with @ port colon traversal whitespace", () => {
    expect(() => parseInstallSource("gh:owner/repo@evil:1")).toThrow(
      /disallowed characters/,
    );
    expect(() => parseInstallSource("gh:owner/repo@..")).toThrow(
      /disallowed characters/,
    );
    expect(() => parseInstallSource("gh:owner/repo@a b")).toThrow(
      /disallowed characters/,
    );
  });

  it("accepts canonical github usernames and repo names", () => {
    expect(parseInstallSource("gh:patchworkos/recipes")).toEqual({
      type: "github",
      owner: "patchworkos",
      repo: "recipes",
    });
    // Hyphens, dots, underscores all allowed inside.
    expect(parseInstallSource("gh:my-org/my.repo_name")).toEqual({
      type: "github",
      owner: "my-org",
      repo: "my.repo_name",
    });
  });

  it("accepts a clean ref (branch/tag/sha)", () => {
    expect(parseInstallSource("gh:owner/repo@v1.2.3")).toEqual({
      type: "github",
      owner: "owner",
      repo: "repo",
      ref: "v1.2.3",
    });
    expect(parseInstallSource("gh:owner/repo@deadbeef")).toEqual({
      type: "github",
      owner: "owner",
      repo: "repo",
      ref: "deadbeef",
    });
  });

  it("rejects names exceeding 39 chars", () => {
    const longRepo = "a".repeat(40);
    expect(() => parseInstallSource(`gh:owner/${longRepo}`)).toThrow(
      /not a valid GitHub repository/,
    );
  });
});
