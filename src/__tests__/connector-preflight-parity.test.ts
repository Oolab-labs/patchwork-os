/**
 * Connector ⇄ install-time *preflight* parity ratchet.
 *
 * Sibling of `connector-step-parity.test.ts` (which guards registry ⇄ recipe
 * steps). This one guards recipe steps ⇄ the connectorPreflight namespace map.
 *
 * `detectRequiredConnectors` (src/recipes/connectorPreflight.ts) maps a recipe
 * step's tool namespace to a connector id so the install panel can warn the
 * user about missing authorisations BEFORE the recipe hard-throws on first
 * run. The static `TOOL_NAMESPACE_TO_CONNECTOR` map historically covered only
 * ~19 of the ~45 connector-backed namespaces — so a recipe using e.g.
 * `postgres.*`, `stripe.*` or `twilio.*` got NO missing-auth warning and then
 * crashed at runtime.
 *
 * The durable fix is this ratchet: every namespace that has a registered
 * recipe-step tool AND resolves to a real connector id MUST have a matching
 * preflight mapping. Any intentional exclusion goes in the explicit allowlist
 * below with a reason. A new connector-backed namespace added without a
 * preflight entry fails the build.
 */
import { describe, expect, it } from "vitest";
import { CONNECTORS } from "../connectors/connectorRegistry.js";
import { TOOL_NAMESPACE_TO_CONNECTOR } from "../recipes/connectorPreflight.js";
import "../recipes/tools/index.js";
import { getNamespaces } from "../recipes/toolRegistry.js";

/**
 * Recipe-step namespaces that differ from their connector id (Google family
 * brevity aliases). Same shape as connector-step-parity.test.ts.
 */
const NAMESPACE_TO_CONNECTOR_ID: Record<string, string> = {
  calendar: "google-calendar",
  drive: "google-drive",
  docs: "google-docs",
};

function namespaceToConnectorId(namespace: string): string {
  return NAMESPACE_TO_CONNECTOR_ID[namespace] ?? namespace;
}

const registryIds = new Set(CONNECTORS.map((c) => c.id));

/**
 * Namespaces intentionally excluded from preflight mapping. Empty today —
 * every connector-backed namespace should be detectable. Add an entry with a
 * reason if a namespace is consciously not preflight-able.
 */
const PREFLIGHT_EXCLUSIONS = new Set<string>([]);

/** Connector-backed namespaces that have ≥1 registered recipe-step tool. */
const connectorBackedNamespaces = getNamespaces()
  .filter((ns) => registryIds.has(namespaceToConnectorId(ns)))
  .filter((ns) => !PREFLIGHT_EXCLUSIONS.has(ns))
  .sort();

describe("connector ⇄ preflight parity ratchet", () => {
  it("sanity: there is at least one connector-backed namespace", () => {
    expect(connectorBackedNamespaces.length).toBeGreaterThan(0);
  });

  for (const ns of connectorBackedNamespaces) {
    it(`${ns}: has a TOOL_NAMESPACE_TO_CONNECTOR preflight mapping`, () => {
      const mapped = TOOL_NAMESPACE_TO_CONNECTOR[ns];
      expect(
        typeof mapped === "string" && mapped.length > 0,
        `Namespace "${ns}" has a recipe step (\`${ns}.*\`) backing connector ` +
          `"${namespaceToConnectorId(ns)}" but no entry in ` +
          `TOOL_NAMESPACE_TO_CONNECTOR (src/recipes/connectorPreflight.ts). ` +
          `Recipes using it get NO install-time missing-auth warning and ` +
          `hard-throw on first run. Add "${ns}": "${namespaceToConnectorId(ns)}" ` +
          `to the map, or add "${ns}" to PREFLIGHT_EXCLUSIONS with a reason.`,
      ).toBe(true);
    });

    it(`${ns}: preflight mapping resolves to the correct connector id`, () => {
      const mapped = TOOL_NAMESPACE_TO_CONNECTOR[ns];
      if (typeof mapped !== "string") return; // covered by the test above
      expect(mapped).toBe(namespaceToConnectorId(ns));
    });
  }

  // No mapping should point at a connector id that isn't in the registry.
  for (const [ns, connectorId] of Object.entries(TOOL_NAMESPACE_TO_CONNECTOR)) {
    it(`${ns}: maps to a real registry connector ("${connectorId}")`, () => {
      expect(
        registryIds.has(connectorId),
        `TOOL_NAMESPACE_TO_CONNECTOR["${ns}"] = "${connectorId}" but that id ` +
          `is not in the connector registry. Remove or correct the entry.`,
      ).toBe(true);
    });
  }
});
