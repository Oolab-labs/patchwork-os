/**
 * `patchwork recipe list` — enumerate recipes the way the bridge does.
 *
 * The previous implementation called `listInstalledRecipes` from
 * `commands/recipeInstall.ts`, which enumerates INSTALL DIRECTORIES only:
 *
 *     if (!statSync(itemPath).isDirectory()) continue;
 *
 * A second exported function of the SAME NAME lives in `recipesHttp.ts` and
 * runs two passes — flat `*.yaml`/`*.yml`/`*.json` recipe files, then install
 * dirs. That one is what `GET /recipes`, the dashboard and the orchestrator
 * use, so it is what actually runs. Two same-named exports answering different
 * questions is how the CLI ended up wired to the narrower one (#1360).
 *
 * The directory-only view was not merely smaller. It printed any directory
 * containing a `.yaml` as an installed recipe, including one with no manifest
 * and no valid entrypoint — so its output was part omission and part phantom.
 *
 * Two rules here, both learned from that:
 *
 *   1. Prefer the bridge when one is discoverable. It is the process that
 *      actually dispatches triggers, so its view is the one an operator is
 *      reasoning about.
 *   2. SAY which view was used. The old behaviour's real damage was that it
 *      was silent: an operator saw a short list and had no way to tell it
 *      apart from a short installation.
 */

import { findBridgeLock } from "../bridgeLockDiscovery.js";
import { patchworkPath } from "../patchworkHome.js";
import { listInstalledRecipes } from "../recipesHttp.js";

export interface RecipeListRow {
  name: string;
  enabled: boolean;
  description?: string;
  trigger?: string;
}

export interface RecipeListResult {
  /** Which enumeration answered. Always reported to the operator. */
  source: "bridge" | "local";
  /** Present only for `source: "bridge"`. */
  port?: number;
  /**
   * Why the bridge was not used, when it wasn't. `null` for a successful
   * bridge read. Surfaced so a silent downgrade is impossible.
   */
  fallbackReason?: string;
  rows: RecipeListRow[];
}

interface BridgeLock {
  port: number;
  authToken: string;
}

export interface RecipeListDeps {
  findBridge?: () => BridgeLock | null;
  fetch?: typeof globalThis.fetch;
  /** Local two-pass scan. Injected in tests; defaults to the real scanner. */
  localScan?: () => RecipeListRow[];
  recipesDir?: string;
}

function defaultLocalScan(recipesDir?: string): RecipeListRow[] {
  // `patchworkPath` honours PATCHWORK_HOME. The bridge's own wiring still
  // hardcodes `join(homedir(), ".patchwork", "recipes")` (#1265), so under an
  // override the two can disagree — a separate defect, not one to paper over
  // here by copying the hardcoded path.
  const dir = recipesDir ?? patchworkPath("recipes");
  const result = listInstalledRecipes(dir);
  return result.recipes.map((r) => ({
    name: r.name,
    enabled: r.enabled !== false,
    description: r.description,
    trigger: r.trigger,
  }));
}

/**
 * Resolve the recipe list, preferring a live bridge.
 *
 * Never throws on a bridge problem: an unreachable or erroring bridge falls
 * back to the local scan WITH a stated reason. A hard failure here would make
 * `recipe list` less useful than the broken version it replaces, and the whole
 * point is that the operator can always see something and always knows what
 * they are seeing.
 */
export async function resolveRecipeList(
  deps: RecipeListDeps = {},
): Promise<RecipeListResult> {
  const findBridge = deps.findBridge ?? (() => findBridgeLock());
  const doFetch = deps.fetch ?? globalThis.fetch;
  const localScan = deps.localScan ?? (() => defaultLocalScan(deps.recipesDir));

  let lock: BridgeLock | null = null;
  try {
    lock = findBridge();
  } catch {
    lock = null;
  }

  if (!lock) {
    return {
      source: "local",
      fallbackReason: "no running bridge found",
      rows: localScan(),
    };
  }

  try {
    const res = await doFetch(`http://127.0.0.1:${lock.port}/recipes`, {
      headers: { Authorization: `Bearer ${lock.authToken}` },
    });
    if (!res.ok) {
      return {
        source: "local",
        fallbackReason: `bridge on port ${lock.port} returned HTTP ${res.status}`,
        rows: localScan(),
      };
    }
    const body = (await res.json()) as {
      recipes?: Array<{
        name?: string;
        enabled?: boolean;
        description?: string;
        trigger?: string;
      }>;
    };
    const rows: RecipeListRow[] = (body.recipes ?? [])
      .filter((r): r is { name: string } & typeof r =>
        Boolean(r && typeof r.name === "string"),
      )
      .map((r) => ({
        name: r.name,
        enabled: r.enabled !== false,
        description: r.description,
        trigger: r.trigger,
      }));
    return { source: "bridge", port: lock.port, rows };
  } catch (err) {
    return {
      source: "local",
      fallbackReason: `bridge on port ${lock.port} unreachable (${
        err instanceof Error ? err.message : String(err)
      })`,
      rows: localScan(),
    };
  }
}

/** Column-aligned rendering, with the source line first. */
export function printRecipeList(result: RecipeListResult): void {
  const provenance =
    result.source === "bridge"
      ? `Source: running bridge on port ${result.port} (authoritative)`
      : `Source: local scan of the recipes directory — ${result.fallbackReason}`;
  console.log(provenance);
  console.log("");

  if (result.rows.length === 0) {
    console.log(
      "No recipes found. Use `patchwork recipe install <source>` to install one,",
    );
    console.log("or `patchwork recipe new <name>` to scaffold one.");
    return;
  }

  const maxName = Math.max(...result.rows.map((r) => r.name.length), 4);
  const maxTrigger = Math.max(
    ...result.rows.map((r) => (r.trigger ?? "—").length),
    7,
  );
  const header = `${"Name".padEnd(maxName)}  ${"Trigger".padEnd(maxTrigger)}  Status    Description`;
  console.log(header);
  console.log("-".repeat(Math.min(header.length, 100)));

  for (const row of result.rows) {
    const trigger = (row.trigger ?? "—").padEnd(maxTrigger);
    const status = (row.enabled ? "enabled" : "disabled").padEnd(8);
    // Flatten first, THEN truncate. A block-scalar YAML description carries
    // real newlines, and emitting them raw breaks the column alignment for
    // every row after it — visible immediately against the live bridge.
    const raw = (row.description ?? "").replace(/\s+/g, " ").trim();
    const detail = raw.length > 120 ? `${raw.slice(0, 117)}…` : raw;
    console.log(
      `${row.name.padEnd(maxName)}  ${trigger}  ${status}  ${detail}`,
    );
  }
  console.log("");
  console.log(`${result.rows.length} recipe(s).`);
}
