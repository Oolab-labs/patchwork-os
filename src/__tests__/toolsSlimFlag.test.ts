/**
 * `patchwork tools list|search --slim` lists the slim set (Private/52 LOW).
 *
 * `--slim` is in `patchwork --help` and docs/guide/cli.md, and the command
 * accepted it and did nothing: the full catalog came back either way.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { runToolsCommand } from "../commands/tools.js";
import { SLIM_TOOL_NAMES } from "../tools/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

async function listed(argv: string[]): Promise<string[]> {
  const written: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    written.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
  await runToolsCommand(argv);
  vi.restoreAllMocks();
  const parsed = JSON.parse(written.join("")) as
    | Record<string, Array<{ name: string }>>
    | Array<{ name: string }>;
  const entries = Array.isArray(parsed) ? parsed : Object.values(parsed).flat();
  return [...new Set(entries.map((e) => e.name))];
}

describe("tools --slim", () => {
  it("list --slim returns only slim tools, and fewer than the full list", async () => {
    const full = await listed(["list", "--json"]);
    const slim = await listed(["list", "--slim", "--json"]);
    expect(slim.length).toBeGreaterThan(0);
    expect(slim.length).toBeLessThan(full.length);
    for (const n of slim) expect(SLIM_TOOL_NAMES.has(n)).toBe(true);
  });

  it("search --slim excludes a full-only match", async () => {
    // gitCommit is full-only; getGitStatus is not slim either. Pick a query
    // that matches a full-only tool by name.
    expect(SLIM_TOOL_NAMES.has("gitCommit")).toBe(false);
    const full = await listed(["search", "gitCommit", "--json"]);
    const slim = await listed(["search", "gitCommit", "--slim", "--json"]);
    expect(full).toContain("gitCommit");
    expect(slim).not.toContain("gitCommit");
  });
});
