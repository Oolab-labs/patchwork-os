/**
 * Evidence workspace tag.
 *
 * The point of these tests is not that a hash function hashes. It is that the
 * id behaves like an *attribution* — stable where the workspace is the same,
 * distinct where it is not, and ABSENT rather than invented when there is
 * nothing to attribute to.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { currentWorkspaceId, workspaceIdFor } from "../workspaceId.js";

describe("the id identifies a workspace, not a string", () => {
  it("treats trailing slashes and `.` segments as the same workspace", () => {
    // A trailing slash in a config file must not silently split an audit trail
    // in two. This is the whole reason the path is normalised first.
    const a = workspaceIdFor("/synthetic/ws");
    expect(workspaceIdFor("/synthetic/ws/")).toBe(a);
    expect(workspaceIdFor("/synthetic/./ws")).toBe(a);
    expect(workspaceIdFor("  /synthetic/ws  ")).toBe(a);
  });

  it("distinguishes different workspaces", () => {
    expect(workspaceIdFor("/synthetic/ws-a")).not.toBe(
      workspaceIdFor("/synthetic/ws-b"),
    );
  });

  it("is stable across calls", () => {
    expect(workspaceIdFor("/synthetic/ws")).toBe(
      workspaceIdFor("/synthetic/ws"),
    );
  });

  it("resolves a relative path so it cannot depend on the caller's cwd", () => {
    expect(workspaceIdFor("ws")).toBe(workspaceIdFor(path.resolve("ws")));
  });
});

describe("it never invents an attribution", () => {
  it("returns undefined for absent or empty input", () => {
    // An evidence row that OMITS the field says nothing. A row carrying
    // "unknown" asserts that somebody looked and could not tell. Those are
    // different claims and only one of them is true here.
    expect(currentWorkspaceId(undefined)).toBeUndefined();
    expect(currentWorkspaceId("")).toBeUndefined();
    expect(currentWorkspaceId("   ")).toBeUndefined();
  });
});

describe("it does not disclose the path", () => {
  it("contains no fragment of the workspace path", () => {
    // Evidence records are the artefacts most likely to leave the machine, and
    // a path names directories and often a person (`/Users/<name>/...`).
    const id = workspaceIdFor("/Users/someone/Documents/Secret Project");
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    for (const fragment of ["Users", "someone", "Documents", "Secret"]) {
      expect(id).not.toContain(fragment.toLowerCase());
    }
  });

  it("stays short enough for a byte-capped log", () => {
    // `runs.jsonl` is capped at 1 MB and that cap already starves the trust
    // ledger (#1337). A full path would be ~7% of a typical row.
    expect(
      workspaceIdFor("/some/very/long/workspace/path/that/goes/on"),
    ).toHaveLength(12);
  });
});

describe("the tag is WIRED, not merely declared", () => {
  // A field on a record type that no writer supplies is indistinguishable at
  // runtime from a feature that was never built — the exact state ADR-0021
  // records for the boundary before `buildAgentExecutorDeps` wired it. These
  // are SOURCE assertions because the failure they guard is a line going
  // missing, which greps reliably and mocks do not.
  //
  // Found the hard way: the first end-to-end check of this change appeared to
  // fail because it was run through the GLOBAL cli, which predated the build.
  // The unit tests above were green throughout.
  const ROOT = path.join(__dirname, "..", "..");
  const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf-8");

  it("gate decisions are stamped at the single record seam", () => {
    // At the seam, not at each call site: one unstamped path is an
    // unattributed decision that nothing reports.
    const src = read("src/recipeOrchestration.ts");
    expect(src).toMatch(/currentWorkspaceId\(/);
    expect(src).toMatch(/workspaceId:\s*wsId/);
  });

  it("boundary receipts and recipe shadow rows are stamped", () => {
    const src = read("src/recipes/yamlRunner.ts");
    expect(src).toMatch(/function evidenceWorkspaceId\(/);
    // Both writers, not just whichever was edited last.
    expect(src.match(/workspaceId:/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("orchestrator shadow rows are stamped", () => {
    const src = read("src/claudeOrchestrator.ts");
    expect(src).toMatch(/currentWorkspaceId\(/);
  });
});
