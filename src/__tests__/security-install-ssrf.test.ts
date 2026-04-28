/**
 * Security tests for SSRF / URL-injection in `recipe install` (CRIT-1 from
 * the 2026-04-28 audit).
 *
 * Two categories:
 *   1. `parseInstallSource` should reject sources whose owner/repo/ref/subdir
 *      contain characters that would change URL semantics (path traversal,
 *      query injection, control chars, ref injection like leading `-`).
 *   2. The HTTP redirect follower in `httpsGet` should refuse redirects whose
 *      `Location` host isn't in a small GitHub-only allowlist.
 *
 * Tests are intentionally failing-first against current `main`.
 */

import { describe, expect, it } from "vitest";
import { parseInstallSource } from "../commands/recipeInstall.js";

describe("CRIT-1: parseInstallSource — owner/repo/ref/subdir validation", () => {
  // owner / repo
  it("rejects owner containing query-string injection", () => {
    expect(() => parseInstallSource("github:owner&token=evil/repo")).toThrow();
  });

  it("rejects owner containing whitespace", () => {
    expect(() => parseInstallSource("github:bad owner/repo")).toThrow();
  });

  it("rejects repo with non-safe characters", () => {
    expect(() => parseInstallSource("github:owner/r..epo")).toThrow();
  });

  it("rejects owner starting with a dash (would be confusable in tooling)", () => {
    expect(() => parseInstallSource("github:-owner/repo")).toThrow();
  });

  it("accepts a normal owner/repo", () => {
    expect(() =>
      parseInstallSource("github:patchworkos/recipes"),
    ).not.toThrow();
  });

  // ref
  it("rejects ref starting with a dash (git flag injection)", () => {
    expect(() => parseInstallSource("github:o/r@-rf-the-world")).toThrow();
  });

  it("rejects ref containing `..` (range syntax / traversal hint)", () => {
    expect(() => parseInstallSource("github:o/r@v1..v2")).toThrow();
  });

  it("rejects ref containing `&` or other URL-meaningful chars", () => {
    expect(() => parseInstallSource("github:o/r@main&inject")).toThrow();
  });

  it("rejects ref containing whitespace", () => {
    expect(() => parseInstallSource("github:o/r@bad ref")).toThrow();
  });

  it("accepts a normal git tag/branch/sha", () => {
    expect(() => parseInstallSource("github:o/r@v1.0.0")).not.toThrow();
    expect(() => parseInstallSource("github:o/r@main")).not.toThrow();
    expect(() => parseInstallSource("github:o/r@a1b2c3d4")).not.toThrow();
    expect(() => parseInstallSource("github:o/r@feature/xyz")).not.toThrow();
  });

  // subdir
  it("rejects subdir containing `..` segments", () => {
    expect(() => parseInstallSource("github:o/r/foo/../etc")).toThrow();
  });

  it("rejects subdir containing whitespace", () => {
    expect(() => parseInstallSource("github:o/r/bad path")).toThrow();
  });

  it("rejects subdir containing query-string injection", () => {
    expect(() => parseInstallSource("github:o/r/foo&inject")).toThrow();
  });

  it("accepts subdir with normal nested path", () => {
    expect(() =>
      parseInstallSource("github:o/r/morning-brief/v1"),
    ).not.toThrow();
  });
});

describe("CRIT-1: httpsGet — redirect host allowlist", () => {
  // We exercise the helper indirectly by exporting an `isAllowedRedirectHost`
  // predicate the install path uses to validate `res.headers.location`.
  it("isAllowedRedirectHost helper accepts api.github.com", async () => {
    const mod = await import("../commands/recipeInstall.js");
    const fn = (
      mod as unknown as { isAllowedRedirectHost?: (u: string) => boolean }
    ).isAllowedRedirectHost;
    expect(typeof fn).toBe("function");
    expect(fn!("https://api.github.com/repos/foo/bar/contents/")).toBe(true);
  });

  it("isAllowedRedirectHost accepts raw.githubusercontent.com and codeload.github.com", async () => {
    const { isAllowedRedirectHost } = (await import(
      "../commands/recipeInstall.js"
    )) as unknown as { isAllowedRedirectHost: (u: string) => boolean };
    expect(
      isAllowedRedirectHost(
        "https://raw.githubusercontent.com/foo/bar/main/file.yaml",
      ),
    ).toBe(true);
    expect(
      isAllowedRedirectHost(
        "https://codeload.github.com/foo/bar/zip/refs/heads/main",
      ),
    ).toBe(true);
  });

  it("isAllowedRedirectHost rejects an attacker-controlled host", async () => {
    const { isAllowedRedirectHost } = (await import(
      "../commands/recipeInstall.js"
    )) as unknown as { isAllowedRedirectHost: (u: string) => boolean };
    expect(isAllowedRedirectHost("https://evil.example.com/steal")).toBe(false);
    expect(isAllowedRedirectHost("http://api.github.com.evil.com/x")).toBe(
      false,
    );
    expect(isAllowedRedirectHost("https://attacker.com/api.github.com")).toBe(
      false,
    );
  });

  it("isAllowedRedirectHost rejects http (no TLS) even on a github.com host", async () => {
    const { isAllowedRedirectHost } = (await import(
      "../commands/recipeInstall.js"
    )) as unknown as { isAllowedRedirectHost: (u: string) => boolean };
    expect(isAllowedRedirectHost("http://api.github.com/foo")).toBe(false);
  });

  it("isAllowedRedirectHost rejects malformed URLs", async () => {
    const { isAllowedRedirectHost } = (await import(
      "../commands/recipeInstall.js"
    )) as unknown as { isAllowedRedirectHost: (u: string) => boolean };
    expect(isAllowedRedirectHost("not a url")).toBe(false);
    expect(isAllowedRedirectHost("")).toBe(false);
  });
});
