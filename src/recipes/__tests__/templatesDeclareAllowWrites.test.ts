/**
 * Every shipped template acknowledges the writes it performs.
 *
 * `FLAG_ENFORCE_ALLOWWRITES` is OFF by default, so a template that omits
 * `allowWrites` works today — and breaks at its write step the moment an
 * operator turns that hardening flag on, which is a reasonable thing for them
 * to do. Enabling a safety control should not silently disable more than half
 * the template library.
 *
 * Measured when this was written: 22 of 29 shipped templates performed a write
 * they had not acknowledged. All 22 were fixed in the same change, because a
 * guard that fails your own library is a guard someone deletes.
 *
 * The walk is RECURSIVE, and that is not incidental. `templates/recipes` has a
 * `webhook/` subdirectory holding some of the most sensitive templates in the
 * repository, and a non-recursive listing missed it three separate times in
 * one day — each time reporting success over the surface it had looked at.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import "../tools/index.js";
import { getTool } from "../toolRegistry.js";

const ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../templates/recipes",
);

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, acc);
    else if (/\.ya?ml$/.test(e.name)) acc.push(f);
  }
  return acc;
}

interface Step {
  tool?: unknown;
  steps?: unknown;
  do?: unknown;
  fan_out?: { steps?: unknown };
}

function writeTools(steps: unknown, out = new Set<string>()): Set<string> {
  if (!Array.isArray(steps)) return out;
  for (const raw of steps) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Step;
    if (typeof s.tool === "string" && getTool(s.tool)?.isWrite === true) {
      out.add(s.tool);
    }
    writeTools(s.steps, out);
    if (Array.isArray(s.do)) writeTools(s.do, out);
    else if (s.do && typeof s.do === "object") writeTools([s.do], out);
    if (s.fan_out) writeTools(s.fan_out.steps, out);
  }
  return out;
}

let files: string[];
beforeAll(() => {
  files = walk(ROOT);
});

describe("shipped templates acknowledge their writes", () => {
  it("finds templates in subdirectories too", () => {
    // Guards the assertion below against passing vacuously, and specifically
    // against the non-recursive listing that missed webhook/ three times.
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.includes(`${path.sep}webhook${path.sep}`))).toBe(
      true,
    );
  });

  it("registers the tools templates call, so isWrite is meaningful", () => {
    // Without this, an empty registry makes every template look write-free and
    // the real assertion passes having checked nothing.
    expect(getTool("file.write")?.isWrite).toBe(true);
    expect(getTool("file.append")?.isWrite).toBe(true);
  });

  it("declares every write tool it uses", () => {
    const offenders: string[] = [];
    for (const f of files) {
      let doc: { steps?: unknown; allowWrites?: unknown };
      try {
        doc = parseYaml(readFileSync(f, "utf8")) as typeof doc;
      } catch {
        continue;
      }
      if (!doc || !Array.isArray(doc.steps)) continue;
      const declared = Array.isArray(doc.allowWrites)
        ? (doc.allowWrites as string[])
        : [];
      for (const tool of writeTools(doc.steps)) {
        // A namespace entry acknowledges every tool in it, matching the
        // runtime check in yamlRunner.
        const ok =
          declared.includes(tool) ||
          declared.includes(tool.split(".")[0] ?? "");
        if (!ok) offenders.push(`${path.basename(f)} → ${tool}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
