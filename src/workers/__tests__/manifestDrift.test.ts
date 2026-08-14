import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  detectWorkerManifestDrift,
  formatWorkerManifestDrift,
} from "../manifestDrift.js";

const roots: string[] = [];
function dirs(): { templatesDir: string; liveDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), "pw-drift-"));
  roots.push(root);
  const templatesDir = path.join(root, "templates");
  const liveDir = path.join(root, "live");
  mkdirSync(templatesDir);
  mkdirSync(liveDir);
  return { templatesDir, liveDir };
}
function write(dir: string, name: string, body: string): void {
  writeFileSync(path.join(dir, name), body);
}
afterEach(() => {
  while (roots.length)
    rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe("detectWorkerManifestDrift (#1358)", () => {
  it("reports a manifest whose live copy differs from the template", () => {
    // The #1348 shape: the template gained an `owns` entry, the live copy did
    // not, and the gate silently attributed less evidence than it should.
    const { templatesDir, liveDir } = dirs();
    write(templatesDir, "a.worker.yaml", "owns:\n  - issue\n  - fs-write\n");
    write(liveDir, "a.worker.yaml", "owns:\n  - issue\n");

    const drift = detectWorkerManifestDrift({ templatesDir, liveDir });
    expect(drift.drifted).toHaveLength(1);
    expect(drift.drifted[0]?.name).toBe("a.worker.yaml");
    expect(drift.drifted[0]?.templateHash).not.toBe(drift.drifted[0]?.liveHash);
  });

  it("says nothing when the copies match", () => {
    const { templatesDir, liveDir } = dirs();
    write(templatesDir, "a.worker.yaml", "owns:\n  - issue\n");
    write(liveDir, "a.worker.yaml", "owns:\n  - issue\n");

    const drift = detectWorkerManifestDrift({ templatesDir, liveDir });
    expect(drift.drifted).toEqual([]);
    // A report that always prints is one nobody reads.
    expect(formatWorkerManifestDrift(drift)).toEqual([]);
  });

  it("does NOT flag an operator-authored worker as a problem", () => {
    // Four of the eight manifests on the reference install have no template.
    // Treating those as findings would train people to ignore the report.
    const { templatesDir, liveDir } = dirs();
    write(templatesDir, "shipped.worker.yaml", "owns:\n  - issue\n");
    write(liveDir, "shipped.worker.yaml", "owns:\n  - issue\n");
    write(liveDir, "mine.worker.yaml", "owns:\n  - tasks\n");

    const drift = detectWorkerManifestDrift({ templatesDir, liveDir });
    expect(drift.localOnly).toEqual(["mine.worker.yaml"]);
    expect(drift.drifted).toEqual([]);
    expect(formatWorkerManifestDrift(drift)).toEqual([]);
  });

  it("reports a shipped manifest that was never installed", () => {
    const { templatesDir, liveDir } = dirs();
    write(templatesDir, "shipped.worker.yaml", "owns:\n  - issue\n");

    const drift = detectWorkerManifestDrift({ templatesDir, liveDir });
    expect(drift.missingLocally).toEqual(["shipped.worker.yaml"]);
    expect(formatWorkerManifestDrift(drift).join("\n")).toContain(
      "not installed",
    );
  });

  it("ignores line-ending differences", () => {
    // Otherwise a Windows checkout reports every manifest as drifted, and a
    // signal that always fires is indistinguishable from one that never does.
    const { templatesDir, liveDir } = dirs();
    write(templatesDir, "a.worker.yaml", "owns:\n  - issue\n");
    write(liveDir, "a.worker.yaml", "owns:\r\n  - issue\r\n");

    expect(
      detectWorkerManifestDrift({ templatesDir, liveDir }).drifted,
    ).toEqual([]);
  });

  it("ignores non-manifest files in either directory", () => {
    const { templatesDir, liveDir } = dirs();
    write(templatesDir, "README.md", "notes");
    write(liveDir, "notes.txt", "scratch");

    const drift = detectWorkerManifestDrift({ templatesDir, liveDir });
    expect(drift).toEqual({ drifted: [], missingLocally: [], localOnly: [] });
  });

  it("does not throw when a directory is missing entirely", () => {
    // A fresh install has no live workers dir. A drift report that crashes the
    // bridge would be a worse failure than the drift it describes.
    const { templatesDir } = dirs();
    expect(() =>
      detectWorkerManifestDrift({
        templatesDir,
        liveDir: path.join(templatesDir, "does-not-exist"),
      }),
    ).not.toThrow();
  });
});
