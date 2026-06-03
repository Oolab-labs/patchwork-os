/**
 * Registry ⇄ dashboard CATALOG parity guard.
 *
 * The shared connector registry (`src/connectors/connectorRegistry.ts`) is the
 * single source of truth for which connectors exist. The dashboard's
 * connection page renders a `CATALOG` array (`dashboard/src/app/connections/
 * page.tsx`) — the user-facing "row in the SUPPORTED set + connect-modal"
 * surface. If those two drift, users either (a) see a connector the bridge
 * can't serve (CATALOG row with no registry entry → 404 end-to-end), or
 * (b) can authenticate a connector that never appears in the UI (registry
 * entry with no CATALOG row → silently unusable from the dashboard).
 *
 * This is the dashboard half of the cross-layer connector-parity invariant
 * (#850). Its siblings:
 *   - `connectorRoutes-registry-parity.test.ts` — registry ⇄ bridge routes
 *   - `connector-step-parity.test.ts`           — registry ⇄ recipe steps
 *
 * The two id sets are in full sync today, so this asserts hard parity (no
 * allowlist): adding a connector to the registry without a CATALOG row — or
 * vice-versa — fails the build before the drift ships.
 *
 * (Invariant 4 from #850 — "documented-default tools register on the default
 * transport" — is already guarded by `streamableHttpToolRegistration.test.ts`,
 * which pins the ctx-platform tools onto the HTTP transport dep list.)
 *
 * Like its route-parity sibling this is a string scan of the dashboard source
 * rather than a cross-package import: the dashboard is a separate Next.js
 * package with its own tsconfig/React deps, so the bridge test reads its
 * source as text and extracts the `{ id: "..." }` literals from the CATALOG
 * array.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONNECTORS } from "../connectors/connectorRegistry.js";

const here = dirname(fileURLToPath(import.meta.url));
const connectionsPagePath = join(
  here,
  "..",
  "..",
  "dashboard",
  "src",
  "app",
  "connections",
  "page.tsx",
);

/** Extract the connector ids from the CATALOG array in the dashboard page. */
function parseDashboardCatalogIds(): Set<string> {
  const src = readFileSync(connectionsPagePath, "utf8");
  const start = src.indexOf("const CATALOG");
  if (start === -1) {
    throw new Error(
      `Could not find 'const CATALOG' in ${connectionsPagePath} — the dashboard ` +
        `connection catalog was renamed/moved; update this parity test.`,
    );
  }
  // Slice to the array terminator so we never match `{ id: "..." }` literals
  // elsewhere in the file (e.g. unrelated maps).
  const end = src.indexOf("];", start);
  const block = src.slice(start, end === -1 ? undefined : end);
  const ids = new Set<string>();
  for (const m of block.matchAll(/\{\s*id:\s*"([a-z0-9-]+)"/g)) {
    ids.add(m[1] as string);
  }
  return ids;
}

const registryIds = new Set(CONNECTORS.map((c) => c.id));
const catalogIds = parseDashboardCatalogIds();

describe("connector registry ⇄ dashboard CATALOG parity", () => {
  it("parses a non-trivial CATALOG (sanity — guards against a broken scan)", () => {
    expect(catalogIds.size).toBeGreaterThan(10);
    expect(registryIds.size).toBeGreaterThan(10);
  });

  // (a) Every registry connector must have a dashboard CATALOG row, else it is
  //     connectable in principle but invisible/unusable from the dashboard.
  for (const id of [...registryIds].sort()) {
    it(`${id}: registry connector has a dashboard CATALOG row`, () => {
      expect(
        catalogIds.has(id),
        `Connector "${id}" is in connectorRegistry.ts but missing from the ` +
          `CATALOG array in dashboard/src/app/connections/page.tsx. Add a row ` +
          `so it shows in the connection UI (or remove it from the registry).`,
      ).toBe(true);
    });
  }

  // (b) No orphan CATALOG rows: a dashboard row with no registry entry surfaces
  //     a connector every bridge call 404s on.
  for (const id of [...catalogIds].sort()) {
    it(`${id}: dashboard CATALOG row has a matching registry connector`, () => {
      expect(
        registryIds.has(id),
        `Connector "${id}" is in the dashboard CATALOG but not in ` +
          `connectorRegistry.ts. Every connect/test/delete call will 404. ` +
          `Add it to the registry or remove the CATALOG row.`,
      ).toBe(true);
    });
  }
});
