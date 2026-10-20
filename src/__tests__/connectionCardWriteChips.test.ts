/**
 * A connection card never says "read only" for a connector that can write
 * (Private/52 LOW).
 *
 * Lives in the bridge tests, not the dashboard's, so the dashboard build never
 * typechecks bridge source. Loads the bridge's real recipe-tool registry — the same one recipes run
 * against — so a write tool added to a connector fails this test until its
 * card says so. Hand-maintained chips are how eight cards came to understate.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import "../recipes/tools/index.js";

// Loaded at RUNTIME from a computed path: a static import would pull dashboard
// source into this package's typecheck (outside rootDir), and importing the
// bridge from a dashboard test pulls bridge source into the Next build.
const chipsModule = join(
  __dirname,
  "..",
  "..",
  "dashboard",
  "src",
  "lib",
  "connectorScopes.ts",
);
const { CONNECTOR_SCOPES, SCOPE_TRANSLATIONS, WRITE_SCOPES } = (await import(
  pathToFileURL(chipsModule).href
)) as {
  CONNECTOR_SCOPES: Record<string, string[]>;
  SCOPE_TRANSLATIONS: Record<string, string>;
  WRITE_SCOPES: Set<string>;
};

import { getNamespaces, listTools } from "../recipes/toolRegistry.js";

/** Card id → recipe-tool namespace, where they differ. */
const NAMESPACE: Record<string, string> = {
  "google-calendar": "calendar",
  "google-drive": "drive",
};

function namespaceFor(card: string): string | undefined {
  const ns = getNamespaces();
  const candidates = [
    NAMESPACE[card],
    card,
    card.replace(/-(.)/g, (_m, c: string) => c.toUpperCase()),
  ].filter((c): c is string => typeof c === "string");
  return candidates.find((c) => ns.includes(c));
}

describe("connection cards", () => {
  it("finds the registry it checks against (a guard over nothing fails)", () => {
    const withWrites = Object.keys(CONNECTOR_SCOPES).filter((card) => {
      const ns = namespaceFor(card);
      return ns !== undefined && listTools(ns).some((t) => t.isWrite);
    });
    expect(withWrites.length).toBeGreaterThanOrEqual(8);
  });

  for (const [card, chips] of Object.entries(CONNECTOR_SCOPES)) {
    it(`${card}: a write chip whenever the connector has a write tool`, () => {
      const ns = namespaceFor(card);
      const writes =
        ns === undefined
          ? []
          : listTools(ns)
              .filter((t) => t.isWrite)
              .map((t) => t.id);
      if (writes.length === 0) return;
      expect(
        chips.some((c) => WRITE_SCOPES.has(c)),
        `${card} exposes ${writes.join(", ")} but every chip reads as read-only`,
      ).toBe(true);
    });
  }

  it("every chip has a label", () => {
    for (const chips of Object.values(CONNECTOR_SCOPES)) {
      for (const c of chips) expect(SCOPE_TRANSLATIONS[c], c).toBeDefined();
    }
  });
});
