import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyActionClass } from "../actionClass.js";
import { loadWorkersFromDir } from "../workerLoader.js";

/**
 * A worker's manifest must own every domain its recipe is allowed to write to.
 *
 * These are two declarations of the same authority, written in different files,
 * with nothing keeping them honest. Butler drifted: its recipe declares
 * `allowWrites: [todoist.create_task, file.append]`, its manifest owns
 * `[tasks-read, tasks]`, and the manifest comment claims it "matches the
 * recipe's actual steps". The receipt step was added later and the manifest was
 * not updated.
 *
 * The failure is quiet in the worst way. An unowned class does not error — the
 * gate floors it to L0 and, because `fs-write` is reversible, the action flows
 * anyway. So the write happens, evidence accrues against a class the worker
 * does not own, and `workers shadow` prints "⚠ NOT OWNED" that nothing acts on.
 * The worker looks busier than it is and none of that work can ever become
 * trust.
 *
 * The check runs the other way round from `owns`-side guards: it starts at what
 * the recipe may actually DO. An `owns` entry with no step behind it is merely
 * useless; a step with no `owns` entry behind it is evidence being thrown away.
 */
describe("guard: a worker manifest covers its recipe's declared writes", () => {
  const workersDir = path.join(process.cwd(), "templates", "workers");
  const recipesDir = path.join(process.cwd(), "templates", "recipes");

  /** `allowWrites:` entries — a flat YAML list of tool ids. */
  function allowWrites(recipeText: string): string[] {
    const lines = recipeText.split("\n");
    const start = lines.findIndex((l) => /^allowWrites:\s*(#.*)?$/.test(l));
    if (start === -1) return [];
    const out: string[] = [];
    for (const line of lines.slice(start + 1)) {
      const m = /^\s+-\s*([A-Za-z0-9_.-]+)\s*(#.*)?$/.exec(line);
      if (!m) break; // first non-list line ends the block
      if (m[1]) out.push(m[1]);
    }
    return out;
  }

  it("every allowWrites tool classifies into a domain the manifest owns", () => {
    const workers = loadWorkersFromDir(workersDir);
    expect(workers.length).toBeGreaterThan(0); // anchor: dir must not be empty

    const gaps: string[] = [];
    let checked = 0;

    for (const w of workers) {
      const recipePath = path.join(recipesDir, `${w.recipe}.yaml`);
      if (!existsSync(recipePath)) continue; // worker ships without its recipe
      const tools = allowWrites(readFileSync(recipePath, "utf-8"));
      if (tools.length === 0) continue;
      checked++;

      const owned = new Set(w.owns.map((o) => String(o).split(":")[0]));
      for (const tool of tools) {
        const { domain } = classifyActionClass(tool);
        if (!owned.has(domain)) {
          gaps.push(`${w.id}: recipe writes ${tool} (${domain}) — not in owns`);
        }
      }
    }

    // Anchor: if no worker/recipe pair was examined, the assertion below is
    // vacuous and would pass however broken the manifests are.
    expect(checked).toBeGreaterThan(0);
    expect(gaps).toEqual([]);
  });

  it("the recipes this guard reads actually declare allowWrites", () => {
    // Premise check. If `allowWrites` were renamed or the parser broke, the
    // guard above would silently examine zero tools per recipe and pass.
    const files = readdirSync(recipesDir).filter((f) => f.endsWith(".yaml"));
    const withWrites = files.filter(
      (f) =>
        allowWrites(readFileSync(path.join(recipesDir, f), "utf-8")).length > 0,
    );
    expect(withWrites.length).toBeGreaterThan(0);
  });
});
