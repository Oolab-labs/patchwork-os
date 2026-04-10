import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildEnforcementReminder } from "../instructionsUtils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("buildEnforcementReminder", () => {
  it("returns an array starting with the BRIDGE TOOL ENFORCEMENT header", () => {
    const block = buildEnforcementReminder();
    expect(block[0]).toBe("BRIDGE TOOL ENFORCEMENT:");
  });

  it("includes representative tools for core categories", () => {
    const text = buildEnforcementReminder().join("\n");
    expect(text).toContain("runTests");
    expect(text).toContain("getDiagnostics");
    expect(text).toContain("gitCommit");
    expect(text).toContain("searchWorkspace");
  });

  it("references bridge-tools.md", () => {
    const text = buildEnforcementReminder().join("\n");
    expect(text).toContain("bridge-tools.md");
  });

  it("returns at least 4 lines", () => {
    expect(buildEnforcementReminder().length).toBeGreaterThanOrEqual(4);
  });

  it("covers all tool categories from templates/bridge-tools.md", () => {
    const templatePath = path.resolve(
      __dirname,
      "../../templates/bridge-tools.md",
    );
    const template = readFileSync(templatePath, "utf-8");
    const reminder = buildEnforcementReminder().join("\n");

    // Extract category headers (#### lines) and their sections
    const categoryPattern = /^#### (.+)$/gm;
    const headers: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = categoryPattern.exec(template)) !== null) {
      headers.push(match[1]);
    }
    expect(headers.length).toBeGreaterThan(0);

    // Split template into per-category sections
    const sections = template.split(/^#### .+$/m).slice(1);
    expect(sections.length).toBe(headers.length);

    for (let i = 0; i < headers.length; i++) {
      const header = headers[i];
      const section = sections[i] ?? "";

      // Extract tool identifiers from the "Call instead" column of each table row.
      // Table rows look like: | `npm test` | `runTests` |
      // We grab camelCase identifiers from the rightmost column.
      const toolsInSection: string[] = [];
      for (const row of section.split("\n")) {
        if (!row.startsWith("|") || row.includes("---")) continue;
        const cols = row
          .split("|")
          .map((c) => c.trim())
          .filter(Boolean);
        if (cols.length < 2) continue;
        const callInstead = cols[cols.length - 1];
        const identifiers = callInstead.match(/\b[a-z][a-zA-Z0-9]+\b/g);
        if (identifiers) toolsInSection.push(...identifiers);
      }

      // At least one tool from this category must appear in the reminder.
      const covered = toolsInSection.some((tool) => reminder.includes(tool));
      expect(
        covered,
        `Category "${header}" has no representative tool in buildEnforcementReminder(). ` +
          `Tools in template: [${toolsInSection.join(", ")}]`,
      ).toBe(true);
    }
  });
});
