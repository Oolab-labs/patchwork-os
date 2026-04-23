import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadFixtureLibrary } from "../fixtureLibrary.js";
import { captureFixture } from "../fixtureRecorder.js";

describe("fixtureRecorder", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("records successful outputs", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "patchwork-fixture-recorder-"));
    const filePath = path.join(tmpDir, "github.json");

    const output = await captureFixture(
      filePath,
      "github",
      "listIssues",
      { repo: "acme/api" },
      async () => [{ id: 1, title: "Bug" }],
    );

    expect(output).toEqual([{ id: 1, title: "Bug" }]);
    const library = loadFixtureLibrary(filePath);
    expect(library?.fixtures[0]?.output).toEqual([{ id: 1, title: "Bug" }]);
  });

  it("records errors and rethrows", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "patchwork-fixture-recorder-"));
    const filePath = path.join(tmpDir, "slack.json");

    await expect(
      captureFixture(
        filePath,
        "slack",
        "postMessage",
        { channel: "alerts" },
        async () => {
          throw new Error("channel_not_found");
        },
      ),
    ).rejects.toThrow("channel_not_found");

    const library = loadFixtureLibrary(filePath);
    expect(library?.fixtures[0]?.error?.message).toBe("channel_not_found");
  });
});
