/**
 * The agent-step sandbox builds its universe from `TIER_MAP ∪ DOMAIN_BY_TOOL`,
 * both static module constants. A plugin registers its MCP tools at runtime, so
 * no plugin tool could ever be enumerated, classified, or added to
 * `--disallowed-tools` — leaving it callable by a worker's agent subprocess at
 * any trust level, while the recipe path gated the very same tool.
 *
 * `disallowedToolsForAgentStep` now accepts the live names, and
 * `buildWorkerAgentDisallowedTools` forwards them. Both of those are covered by
 * behavioural tests. Neither can see whether `Bridge` actually SUPPLIES the
 * list — and a fix nobody supplies an argument to is the whole failure mode
 * being closed here: the previous code was correct, enforced, and pointed at a
 * set that structurally could not contain the tool.
 *
 * WHY THIS TEST READS SOURCE. The deps object is constructed inline inside
 * `Bridge`, behind a recipes-directory probe and a live `RecipeOrchestrator`;
 * there is no seam to inject a fake through without standing up a bridge. A
 * hand-injected dependency would prove the logic and not the path, and the path
 * is the defect. Crude, but it is the thing that would regress. Replace with a
 * behavioural test if a seam is ever added.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BRIDGE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "bridge.ts",
);

describe("Bridge supplies plugin tool names to the agent-step sandbox", () => {
  const src = readFileSync(BRIDGE, "utf8");

  it("constructs RecipeOrchestration exactly once", () => {
    // Pins the assertions below to a single known call site. A second one would
    // make "the key is present somewhere" stop meaning "present on the path".
    const sites = src.match(/new RecipeOrchestration\(/g) ?? [];
    expect(sites).toHaveLength(1);
  });

  it("passes pluginToolNames in that constructor call", () => {
    const start = src.indexOf("new RecipeOrchestration({");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("});", start));
    expect(block).toContain("pluginToolNames:");
  });

  it("reads the registry through a thunk, not a captured snapshot", () => {
    // `--plugin-watch` hot-reloads the registry. A value captured once goes
    // stale, and stale here means a newly-registered tool silently drops back
    // out of the sandbox universe — the same hole, reopened by a later edit.
    const start = src.indexOf("pluginToolNames:");
    expect(start).toBeGreaterThan(-1);
    const decl = src.slice(start, start + 240);
    expect(decl).toMatch(/pluginToolNames:\s*\(\)\s*=>/);
    // and it must consult the watcher's current view, like the tool registry does
    expect(decl).toContain("pluginWatcher?.getTools()");
  });
});
