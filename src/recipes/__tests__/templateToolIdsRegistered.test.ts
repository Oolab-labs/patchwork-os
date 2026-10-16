/**
 * Every tool id a SHIPPED template names must be registered.
 *
 * An unregistered tool id SKIPS the step silently by design (forward compat
 * for un-loaded plugins; see the guard in flatCompoundSteps.test.ts), and
 * `recipe lint` cannot see tool ids. So a typo in a shipped template ships a
 * recipe that finishes `done` having done nothing. Audit 2026-10-15 (H8):
 * `webhook/incident-intake.yaml` called `linear.create_issue`; the registered
 * id is `linear.createIssue`, so its only write step never ran.
 *
 * Scoped to the templates this package ships, where every tool must come
 * from this package. Installed recipes may legitimately name plugin tools.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import "../tools/index.js";
import { hasTool } from "../toolRegistry.js";

const TEMPLATES = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "templates",
  "recipes",
);

function yamlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return yamlFiles(full);
    return /\.ya?ml$/.test(name) ? [full] : [];
  });
}

function toolIds(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) for (const n of node) toolIds(n, out);
  else if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (typeof o.tool === "string") out.push(o.tool);
    for (const v of Object.values(o)) toolIds(v, out);
  }
  return out;
}

describe("shipped templates name only registered tools", () => {
  const files = yamlFiles(TEMPLATES);

  it("finds the templates (a scan of zero files must fail)", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("every `tool:` id in every shipped template is registered", () => {
    const missing = files.flatMap((f) => {
      const doc = parseYaml(readFileSync(f, "utf-8")) as { steps?: unknown };
      return toolIds(doc?.steps)
        .filter((id) => !id.includes("{{") && !hasTool(id))
        .map((id) => `${path.relative(TEMPLATES, f)}: ${id}`);
    });
    expect(missing).toEqual([]);
  });
});
