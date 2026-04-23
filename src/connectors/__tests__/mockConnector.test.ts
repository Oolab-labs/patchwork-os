import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFixtureLibrary,
  findFixture,
  loadFixtureLibrary,
  recordFixture,
} from "../fixtureLibrary.js";
import { MockConnector } from "../mockConnector.js";

describe("fixtureLibrary", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("records and loads fixtures from disk", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "patchwork-fixtures-"));
    const filePath = path.join(tmpDir, "github.json");

    recordFixture(filePath, "github", {
      operation: "listIssues",
      input: { repo: "acme/api", state: "open" },
      output: [{ id: 1, title: "Bug" }],
    });

    const library = loadFixtureLibrary(filePath);
    expect(library?.provider).toBe("github");
    expect(library?.fixtures).toHaveLength(1);
    expect(readFileSync(filePath, "utf-8")).toContain("listIssues");
  });

  it("matches fixtures regardless of object key order", () => {
    const library = createFixtureLibrary("linear");
    library.fixtures.push({
      operation: "createIssue",
      input: { title: "Test", team: "ENG" },
      output: { id: "issue-1" },
    });

    const fixture = findFixture(library, "createIssue", {
      team: "ENG",
      title: "Test",
    });

    expect(fixture?.output).toEqual({ id: "issue-1" });
  });
});

describe("MockConnector", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns fixture output for a matched operation", async () => {
    const connector = new MockConnector("github");
    connector.addFixture({
      operation: "listIssues",
      input: { repo: "acme/api" },
      output: [{ id: 123, title: "Fix bug" }],
    });

    const issues = await connector.invoke<Array<{ id: number; title: string }>>(
      "listIssues",
      { repo: "acme/api" },
    );

    expect(issues[0]?.id).toBe(123);
    expect(connector.getCalls()).toEqual([
      {
        operation: "listIssues",
        input: { repo: "acme/api" },
        matched: true,
      },
    ]);
  });

  it("throws when no fixture matches", async () => {
    const connector = new MockConnector("slack");

    await expect(
      connector.invoke("postMessage", { channel: "alerts", text: "hi" }),
    ).rejects.toThrow("No mock fixture for slack.postMessage");
  });

  it("persists added fixtures when a fixture path is provided", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "patchwork-mock-connector-"));
    const fixturePath = path.join(tmpDir, "gmail.json");
    const connector = new MockConnector("gmail", { fixturePath });

    connector.addFixture({
      operation: "search",
      input: { query: "from:alerts@example.com" },
      output: { count: 1 },
    });

    const reloaded = loadFixtureLibrary(fixturePath);
    expect(reloaded?.fixtures).toHaveLength(1);
    expect(reloaded?.fixtures[0]?.operation).toBe("search");
  });
});
