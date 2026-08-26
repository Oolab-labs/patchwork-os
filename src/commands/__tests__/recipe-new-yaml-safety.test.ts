/**
 * `recipe new` must emit YAML that parses.
 *
 * The scaffold substituted the description into `description: {{description}}`
 * raw. The CLI's own default is `Recipe: <name>` — a value containing ": " —
 * so EVERY recipe scaffolded without an explicit `--desc` was invalid YAML
 * from birth: "Nested mappings are not allowed in compact mappings".
 *
 * The command reported `✓ Created` regardless, because nothing parsed the
 * file it had just written. The breakage surfaced only later and elsewhere:
 * `privacy undeclared` counting a recipe it "could not parse", and the bridge
 * skipping it at startup.
 *
 * These tests parse the emitted content. Asserting on the substituted string
 * would pass against the broken version.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { runNew } from "../recipe.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "recipe-new-yaml-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runNew emits parseable YAML", () => {
  it("survives the CLI's own default description", () => {
    // Exactly what src/index.ts passes when `--desc` is omitted.
    const { content } = runNew({
      name: "scaffold-probe",
      description: "Recipe: scaffold-probe",
      outputDir: dir,
    });
    const parsed = parseYaml(content) as { description?: unknown };
    expect(parsed.description).toBe("Recipe: scaffold-probe");
  });

  it.each([
    ["a colon mid-value", "Nightly: tidy the inbox"],
    ["a leading quote", '"quoted" from the start'],
    ["a trailing colon", "see also:"],
    ["a hash", "tidy # the inbox"],
    ["a leading dash", "- not a list item"],
    ["a brace", "{not a map}"],
  ])("survives %s", (_label, description) => {
    const { content } = runNew({
      name: "scaffold-probe",
      description,
      outputDir: dir,
    });
    const parsed = parseYaml(content) as { description?: unknown };
    expect(parsed.description).toBe(description);
  });

  it("keeps the name intact and still parses", () => {
    const { content } = runNew({
      name: "scaffold-probe",
      description: "ordinary text",
      outputDir: dir,
    });
    const parsed = parseYaml(content) as { name?: unknown };
    expect(parsed.name).toBe("scaffold-probe");
  });
});
