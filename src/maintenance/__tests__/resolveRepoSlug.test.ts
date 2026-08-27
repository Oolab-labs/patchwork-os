/**
 * The collector must say why it failed, in the failing tool's own words.
 *
 * `gh repo view` ran with stderr set to "ignore", so every failure — expired
 * credentials, no network, gh not installed, not a git repo — collapsed into
 * one guess: "could not determine the repository. Pass --repo owner/name."
 *
 * Observed 2026-08-28 with a stale `GITHUB_TOKEN` in the environment: gh
 * returned `HTTP 401: Bad credentials` and the operator was told they had a
 * repository problem. Nothing about the repository was wrong, and `--repo`
 * would not have helped.
 *
 * The tests assert the underlying message SURVIVES. Asserting that some error
 * is returned would pass against the version that threw the cause away.
 */

import { describe, expect, it } from "vitest";
import { resolveRepoSlug } from "../prOutcomeLedger.js";

describe("resolveRepoSlug", () => {
  it("returns the slug when gh succeeds", () => {
    const r = resolveRepoSlug(() => ({ ok: true, stdout: "acme/widgets\n" }));
    expect(r.repo).toBe("acme/widgets");
    expect(r.error).toBeUndefined();
  });

  it("surfaces an auth failure verbatim, not as a repository problem", () => {
    const r = resolveRepoSlug(() => ({
      ok: false,
      stderr: "HTTP 401: Bad credentials (https://api.github.com/graphql)\n",
    }));
    expect(r.repo).toBeUndefined();
    expect(r.error).toContain("401");
    expect(r.error).toContain("Bad credentials");
    // The old message actively misdirected. It must not come back.
    expect(r.error).not.toMatch(/could not determine the repository/i);
  });

  it("surfaces a not-a-repo failure verbatim too", () => {
    const r = resolveRepoSlug(() => ({
      ok: false,
      stderr: "no git remotes found\n",
    }));
    expect(r.error).toContain("no git remotes found");
  });

  it("says so when the tool failed and explained nothing", () => {
    // Silence is its own fact and must not be dressed up as a diagnosis.
    const r = resolveRepoSlug(() => ({ ok: false, stderr: "   \n" }));
    expect(r.error).toMatch(/said nothing/);
  });

  it("distinguishes an unusable ANSWER from a failure", () => {
    // gh exited 0 and handed back something unusable. Reporting that as
    // "could not determine" would misdescribe a value we did receive.
    const r = resolveRepoSlug(() => ({ ok: true, stdout: "\n" }));
    expect(r.repo).toBeUndefined();
    expect(r.error).toMatch(/unusable value/);
  });

  it("rejects a slug that is not owner/name", () => {
    const r = resolveRepoSlug(() => ({ ok: true, stdout: "just-a-name\n" }));
    expect(r.repo).toBeUndefined();
    expect(r.error).toMatch(/unusable value/);
  });
});
