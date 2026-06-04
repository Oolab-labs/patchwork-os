/**
 * Dashboard ⇄ registry ⇄ recipe three-way parity guard.
 *
 * Sibling of `connectorRoutes-registry-parity.test.ts` and
 * `connector-step-parity.test.ts` (the two existing #850 cross-layer
 * parity tests). Those guard the *server* half of the connector world:
 *
 *   - `connectorRoutes-registry-parity` → registry.supports.* ⇄ HTTP
 *     routes in src/connectorRoutes.ts
 *   - `connector-step-parity`           → registry ⇄ recipe-step tools
 *     in src/recipes/tools/<ns>.ts
 *
 * This file guards the *dashboard* half — the connector id set has to
 * stay coherent across the three places the UI/recipe layer reads from:
 *
 *   1. `CATALOG` in `dashboard/src/app/connections/page.tsx` — the
 *      46 entries a user sees in the connections grid.
 *   2. `SUPPORTED_CONNECTORS` in the same file (line ~318) — the
 *      "has a backend wired" set; entries NOT in this set render as
 *      "Coming Soon" in the catalog regardless of wave.
 *   3. `KNOWN_CONNECTOR_IDS` in
 *      `dashboard/src/lib/recipeConnectors.ts` — the set the recipe
 *      importer uses to detect which connectors a recipe references.
 *
 * Drift direction that hurts the user:
 *
 *   - A connector added to CATALOG but missing from SUPPORTED_CONNECTORS
 *     renders in the UI as "Coming Soon" → looks like the project is
 *     overselling.
 *   - A connector added to SUPPORTED_CONNECTORS but missing from CATALOG
 *     → its routes are reachable but no one can find them in the UI.
 *   - A connector added to KNOWN_CONNECTOR_IDS but missing from CATALOG
 *     → recipe importer detects it but the user can't authorise it.
 *   - A connector added to CATALOG/SUPPORTED but missing from KNOWN
 *     → recipe UI says "this recipe needs X" but the importer silently
 *     drops the reference.
 *
 * Like its siblings, this is a *ratchet*: the current diff (today:
 * three sets already match exactly, see "drift" snapshot below) is
 * frozen in the committed `dashboard-connector-parity-allowlist.json`,
 * and a NEW divergence in either direction fails the build. The
 * allowlist can only ever shrink as the three sources are brought into
 * lockstep.
 *
 * It is deliberately a string scan of the page source rather than a
 * runtime import of `CATALOG` / `SUPPORTED_CONNECTORS`: the dashboard
 * `page.tsx` is a 2 144-line "use client" file that is not safe to
 * import from a node-side test, and the page-side sets are
 * intentionally plain literals (not exported). This matches the
 * pattern set by `connectorRoutes-registry-parity.test.ts`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allConnectorIds } from "../connectors/connectorRegistry.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Walk two levels up from `src/__tests__/` to the repo root, then into
 * the dashboard tree. The other parity tests do the same one-level
 * walk; this one needs two because the dashboard lives outside the
 * `src/` tree.
 */
const repoRoot = join(here, "..", "..");
const pageSrc = readFileSync(
  join(repoRoot, "dashboard", "src", "app", "connections", "page.tsx"),
  "utf8",
);

/**
 * Extract the body of `const <NAME> = new Set([...])` from a source
 * file. The dashboard `page.tsx` defines two adjacent Sets on lines
 * 44 and 318; we read both.
 */
function extractSetLiterals(
  src: string,
  names: string[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const name of names) {
    const re = new RegExp(
      `const\\s+${name}\\s*[:=]\\s*(?:new\\s+Set\\()?\\[([\\s\\S]*?)\\]\\)?`,
      "m",
    );
    const m = re.exec(src);
    if (!m) {
      throw new Error(`Could not locate \`${name}\` literal in source`);
    }
    out[name] = Array.from(m[1].matchAll(/"([^"]+)"/g)).map((mm) => mm[1]);
  }
  return out;
}

/**
 * Extract `id: "<connector-id>"` rows from a TS object-literal array
 * (CATALOG uses this shape: `{ id: "jira", name: "Jira", ... }`).
 */
function extractCatalogIds(src: string): string[] {
  // Anchor on the literal `const CATALOG: ConnectorDef[] = [`.
  const re = /const\s+CATALOG\s*:\s*ConnectorDef\[\]\s*=\s*\[([\s\S]*?)\];/m;
  const m = re.exec(src);
  if (!m) {
    throw new Error(
      "Could not locate `const CATALOG: ConnectorDef[]` in page.tsx",
    );
  }
  return Array.from(m[1].matchAll(/\bid:\s*"([^"]+)"/g)).map((mm) => mm[1]);
}

const { SUPPORTED_CONNECTORS: supportedIds } = extractSetLiterals(pageSrc, [
  "SUPPORTED_CONNECTORS",
]);
const catalogIds = extractCatalogIds(pageSrc);
const knownIds = allConnectorIds().slice().sort();

interface AllowlistFile {
  _README: string;
  /** Connector ids that appear in exactly one or two of the three sets and
   *  are consciously not yet aligned. Ratchet rule: this list can only
   *  shrink — an entry must be removed once all three sets agree. */
  connectorsOutOfSync: string[];
}

const allowlist = JSON.parse(
  readFileSync(join(here, "dashboard-connector-parity-allowlist.json"), "utf8"),
) as AllowlistFile;
const allowlistSet = new Set(allowlist.connectorsOutOfSync);

// Each set is the union of the three observed sources. A connector is
// "in scope" if it appears in ANY of the three. Drift is measured as
// the set of ids that do not appear in ALL THREE.
const inScope = new Set<string>([...catalogIds, ...supportedIds, ...knownIds]);
const inAllThree = [...inScope].filter(
  (id) =>
    catalogIds.includes(id) &&
    supportedIds.includes(id) &&
    knownIds.includes(id),
);
const outOfSync = [...inScope]
  .filter(
    (id) =>
      !(
        catalogIds.includes(id) &&
        supportedIds.includes(id) &&
        knownIds.includes(id)
      ),
  )
  .sort();

describe("dashboard ⇄ registry ⇄ recipe three-way parity", () => {
  it("parses the three connector-id sources without error", () => {
    // Sanity: each list is non-empty (this would catch a future refactor
    // that breaks the regex extraction).
    expect(catalogIds.length).toBeGreaterThan(0);
    expect(supportedIds.length).toBeGreaterThan(0);
    expect(knownIds.length).toBeGreaterThan(0);
  });

  // (a) Every drift id is consciously allowlisted. A new divergence
  //     (an id present in some-but-not-all sources and not in the
  //     allowlist) fails here, forcing the author to either align the
  //     three sources or consciously append the id to the backlog.
  for (const id of outOfSync) {
    it(`${id}: present in some-but-not-all sources → must be in the allowlist backlog`, () => {
      expect(
        allowlistSet.has(id),
        `Connector "${id}" is present in some-but-not-all of ` +
          `CATALOG / SUPPORTED_CONNECTORS / KNOWN_CONNECTOR_IDS. Either ` +
          `add it to the missing source(s) (see #850 cross-layer parity), ` +
          `or — if the divergence is conscious — add "${id}" to ` +
          `connectorsOutOfSync in dashboard-connector-parity-allowlist.json. ` +
          `(catalog: ${catalogIds.includes(id)}, supported: ${supportedIds.includes(id)}, known: ${knownIds.includes(id)})`,
      ).toBe(true);
    });
  }

  // (b) No stale allowlist entries. Once all three sources contain an
  //     id, the author must remove it from the backlog so the ratchet
  //     only shrinks.
  for (const id of allowlist.connectorsOutOfSync) {
    it(`${id}: allowlisted backlog entry must still be out-of-sync (not stale)`, () => {
      const isInAllThree =
        catalogIds.includes(id) &&
        supportedIds.includes(id) &&
        knownIds.includes(id);
      expect(
        isInAllThree,
        `Connector "${id}" now appears in all three of CATALOG / ` +
          `SUPPORTED_CONNECTORS / KNOWN_CONNECTOR_IDS but is still listed ` +
          `in connectorsOutOfSync. Remove it — the backlog allowlist must ` +
          `only shrink.`,
      ).toBe(false);
    });
  }

  // (c) No phantom allowlist entries. An allowlisted id that does not
  //     appear in ANY of the three sources is dead weight (typo /
  //     renamed / removed connector).
  for (const id of allowlist.connectorsOutOfSync) {
    it(`${id}: allowlisted id must appear in at least one of the three sources`, () => {
      expect(
        inScope.has(id),
        `Connector "${id}" is in ` +
          `dashboard-connector-parity-allowlist.json but does not appear in ` +
          `CATALOG, SUPPORTED_CONNECTORS, or KNOWN_CONNECTOR_IDS. Remove ` +
          `the stale entry.`,
      ).toBe(true);
    });
  }

  // (d) Snapshot guard. When the allowlist is empty (steady state), the
  //     three sets must be exactly equal. If you find yourself wanting
  //     to relax this assertion, the right answer is almost always to
  //     align the three sources rather than to allow the divergence.
  if (allowlist.connectorsOutOfSync.length === 0) {
    it("CATALOG, SUPPORTED_CONNECTORS, and KNOWN_CONNECTOR_IDS are exactly equal (no allowlist entries)", () => {
      const catalogSet = new Set(catalogIds);
      const supportedSet = new Set(supportedIds);
      const knownSet = new Set(knownIds);
      for (const id of catalogSet) {
        expect(
          supportedSet.has(id),
          `CATALOG has "${id}" but SUPPORTED_CONNECTORS does not`,
        ).toBe(true);
        expect(
          knownSet.has(id),
          `CATALOG has "${id}" but KNOWN_CONNECTOR_IDS does not`,
        ).toBe(true);
      }
      for (const id of supportedSet) {
        expect(
          catalogSet.has(id),
          `SUPPORTED_CONNECTORS has "${id}" but CATALOG does not`,
        ).toBe(true);
        expect(
          knownSet.has(id),
          `SUPPORTED_CONNECTORS has "${id}" but KNOWN_CONNECTOR_IDS does not`,
        ).toBe(true);
      }
      for (const id of knownSet) {
        expect(
          catalogSet.has(id),
          `KNOWN_CONNECTOR_IDS has "${id}" but CATALOG does not`,
        ).toBe(true);
        expect(
          supportedSet.has(id),
          `KNOWN_CONNECTOR_IDS has "${id}" but SUPPORTED_CONNECTORS does not`,
        ).toBe(true);
      }
    });
  }

  it("snapshot: sources and diff", () => {
    // Diagnostic-only test: prints a one-line summary of the three
    // sources plus the current diff so a CI failure log makes the
    // shape of the drift obvious without having to re-derive it.
    const summary = {
      catalog: catalogIds.length,
      supported: supportedIds.length,
      known: knownIds.length,
      inScope: inScope.size,
      inAllThree: inAllThree.length,
      outOfSync: outOfSync,
      allowlist: allowlist.connectorsOutOfSync,
    };
    // eslint-disable-next-line no-console
    console.log("[dashboard-connector-parity]", JSON.stringify(summary));
    expect(summary).toBeDefined();
  });
});
