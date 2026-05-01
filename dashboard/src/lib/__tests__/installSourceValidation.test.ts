/**
 * Regression test for Bug 2: marketplace install must validate the install
 * source string against parseInstallSource BEFORE POSTing to the bridge.
 *
 * If a tampered registry index sneaks an opaque or attacker-shaped install
 * string through (e.g. `https://evil/cmd`, `file:///etc/passwd`, a leading
 * dash to confuse downstream argv parsing), the dashboard must surface a
 * user-visible error and refuse to forward to the bridge.
 *
 * The dashboard call sites in marketplace/page.tsx and marketplace/[...slug]/
 * InstallPanel.tsx use `assertValidInstallSource` from registry.ts as the
 * single source of truth.
 */

import { describe, expect, it } from "vitest";
import { assertValidInstallSource, parseInstallSource } from "@/lib/registry";

describe("parseInstallSource (regex shape)", () => {
  it("accepts canonical github:owner/repo@ref", () => {
    expect(parseInstallSource("github:patchworkos/recipes@v1")).toEqual({
      owner: "patchworkos",
      repo: "recipes",
      path: "",
      ref: "v1",
    });
  });

  it("accepts github:owner/repo/sub/dir@ref", () => {
    expect(parseInstallSource("github:patchworkos/recipes/triage@main")).toEqual({
      owner: "patchworkos",
      repo: "recipes",
      path: "triage",
      ref: "main",
    });
  });

  it("rejects http/https URLs", () => {
    expect(parseInstallSource("https://evil.example.com/recipe")).toBeNull();
  });

  it("rejects file:// URLs", () => {
    expect(parseInstallSource("file:///etc/passwd")).toBeNull();
  });

  it("rejects strings missing the github: scheme", () => {
    expect(parseInstallSource("patchworkos/recipes@main")).toBeNull();
  });

  it("rejects empty owner / repo", () => {
    expect(parseInstallSource("github:/repo@main")).toBeNull();
    expect(parseInstallSource("github:owner/@main")).toBeNull();
  });
});

describe("assertValidInstallSource — defence-in-depth at the call site", () => {
  it("returns the parsed shape for valid sources", () => {
    const parsed = assertValidInstallSource("github:patchworkos/recipes@v1");
    expect(parsed.owner).toBe("patchworkos");
    expect(parsed.repo).toBe("recipes");
  });

  it("throws a user-facing Error for opaque sources", () => {
    expect(() => assertValidInstallSource("https://evil/cmd")).toThrow(
      /invalid install source/i,
    );
  });

  it("throws for empty / whitespace input", () => {
    expect(() => assertValidInstallSource("")).toThrow();
    expect(() => assertValidInstallSource("   ")).toThrow();
  });

  it("throws for non-string input", () => {
    // The marketplace registry types `install` as string, but a tampered
    // index can ship anything — the helper must coerce-check defensively.
    expect(() => assertValidInstallSource(undefined as unknown as string)).toThrow();
    expect(() => assertValidInstallSource(null as unknown as string)).toThrow();
    expect(() => assertValidInstallSource(42 as unknown as string)).toThrow();
  });
});
