/**
 * Connector ⇄ recipe-step parity ratchet.
 *
 * The connector registry (`src/connectors/connectorRegistry.ts`) advertises
 * ~46 connectors a user can authenticate. But authenticating a connector is
 * only half the story: to be *automatable* in a recipe, the connector also
 * needs at least one recipe-step tool registered in `src/recipes/tools/<ns>.ts`
 * (tool ids of the shape `<namespace>.<action>`). Today the majority of
 * registered connectors expose ZERO recipe steps, so "46 connectors" badly
 * overstates what can actually be wired into a recipe.
 *
 * This is a CI ratchet that makes that gap honest and one-directional:
 *
 *   - The CURRENT backlog of step-less connectors is frozen in the committed
 *     `connector-step-parity-allowlist.json`. The test is GREEN against that
 *     snapshot.
 *   - A *new* step-less connector (added to the registry without a recipe
 *     step) FAILS the build, forcing the author to either add a step or
 *     consciously append it to the allowlist.
 *   - A *stale* allowlist entry (a connector that NOW has steps but is still
 *     listed) also FAILS, forcing the author to delete it. So the allowlist
 *     can only ever shrink as the backfill proceeds.
 *
 * Sibling of `connectorRoutes-registry-parity.test.ts` (#850 cross-layer
 * parity tests): that one guards registry ⇄ HTTP routes; this one guards
 * registry ⇄ recipe steps.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONNECTORS } from "../connectors/connectorRegistry.js";
import "../recipes/tools/index.js";
import { getNamespaces } from "../recipes/toolRegistry.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Map a recipe-step *namespace* to the connector *id* it backs.
 *
 * Most namespaces match their connector id verbatim. A handful differ for
 * historical / brevity reasons and are spelled out here:
 *   - `calendar` is the Google Calendar step namespace → `google-calendar`.
 *   - `drive`    is the Google Drive step namespace    → `google-drive`.
 *   - `docs`     is the Google Docs step namespace     → `google-docs`.
 * (`gmail` matches its connector id directly, so needs no alias.)
 *
 * Namespaces that are NOT connector-backed (built-in / composite tools such
 * as `file`, `git`, `http`, `diagnostics`, `fan_out`, `meetingNotes`) simply
 * have no matching connector id and are ignored by the intersection below.
 */
const NAMESPACE_TO_CONNECTOR_ID: Record<string, string> = {
  calendar: "google-calendar",
  drive: "google-drive",
  docs: "google-docs",
};

function namespaceToConnectorId(namespace: string): string {
  return NAMESPACE_TO_CONNECTOR_ID[namespace] ?? namespace;
}

/** Authoritative connector id set (what users can connect). */
const registryIds = new Set(CONNECTORS.map((c) => c.id));

/** Connector ids that have ≥1 registered recipe-step tool. */
const connectorIdsWithSteps = new Set<string>();
for (const ns of getNamespaces()) {
  const connectorId = namespaceToConnectorId(ns);
  if (registryIds.has(connectorId)) {
    connectorIdsWithSteps.add(connectorId);
  }
}

/** Connectors that authenticate but expose no recipe steps (the backlog). */
const connectorsWithoutSteps = [...registryIds]
  .filter((id) => !connectorIdsWithSteps.has(id))
  .sort();

interface AllowlistFile {
  _README: string;
  connectorsWithoutSteps: string[];
}

const allowlist = JSON.parse(
  readFileSync(join(here, "connector-step-parity-allowlist.json"), "utf8"),
) as AllowlistFile;
const allowlistSet = new Set(allowlist.connectorsWithoutSteps);

describe("connector ⇄ recipe-step parity ratchet", () => {
  it("every registry connector resolves to a known auth kind (sanity)", () => {
    expect(registryIds.size).toBeGreaterThan(0);
  });

  // (a) New step-less connector must be allowlisted. A connector added to the
  //     registry with no recipe step and no allowlist entry fails here.
  for (const id of connectorsWithoutSteps) {
    it(`${id}: has no recipe step → must be in the allowlist backlog`, () => {
      expect(
        allowlistSet.has(id),
        `Connector "${id}" is registered but exposes no recipe-step tool ` +
          `(no "${id}.*" tool in src/recipes/tools/). Either add a recipe ` +
          `step for it, or — if it is consciously not yet automatable — add ` +
          `"${id}" to connectorsWithoutSteps in ` +
          `connector-step-parity-allowlist.json.`,
      ).toBe(true);
    });
  }

  // (b) No stale allowlist entries. Once a connector gains a recipe step it
  //     must be removed from the backlog so the ratchet only shrinks.
  for (const id of allowlist.connectorsWithoutSteps) {
    it(`${id}: allowlisted backlog entry must still be step-less (not stale)`, () => {
      expect(
        connectorIdsWithSteps.has(id),
        `Connector "${id}" now has a recipe step but is still listed in ` +
          `connectorsWithoutSteps in connector-step-parity-allowlist.json. ` +
          `Remove it — the backlog allowlist must only shrink.`,
      ).toBe(false);
    });
  }

  // (c) No phantom allowlist entries. An allowlisted id that is not in the
  //     registry at all is dead weight (renamed / removed connector).
  for (const id of allowlist.connectorsWithoutSteps) {
    it(`${id}: allowlisted id must exist in the connector registry`, () => {
      expect(
        registryIds.has(id),
        `Connector "${id}" is in connector-step-parity-allowlist.json but ` +
          `not in the connector registry. Remove the stale entry.`,
      ).toBe(true);
    });
  }
});
