/** @vitest-environment node */
/**
 * Pin: the four dashboard allowlists must derive from the shared
 * connector registry (src/connectors/connectorRegistry.ts), not from
 * literal Sets duplicated across routes. PR #777 shipped six broken
 * OAuth connectors because those literals drifted from the bridge
 * routes — never again.
 */
import { describe, expect, it } from "vitest";
import {
  authAllowedConnectorIds,
  connectAllowedConnectorIds,
  testAllowedConnectorIds,
  deleteAllowedConnectorIds,
} from "../../../../../../../src/connectors/connectorRegistry";

// Snapshots of the four pre-consolidation Sets. Updating these
// requires updating the registry in the same commit — they document
// the contract the registry replaces.
const EXPECTED_AUTH = new Set([
  "gmail", "google-calendar", "google-drive", "github", "linear", "sentry",
  "slack", "asana", "discord", "gitlab",
  "notion", "confluence", "datadog", "hubspot", "intercom", "stripe", "zendesk",
]);
const EXPECTED_CONNECT = new Set([
  "notion", "confluence", "datadog", "hubspot", "intercom", "stripe",
  "zendesk", "pagerduty",
  // Wave 1a data-store connectors (PAT, lazy driver imports).
  "postgres", "mongodb", "redis", "elasticsearch",
]);
const EXPECTED_TEST = new Set([
  "gmail", "github", "linear", "sentry", "google-calendar", "google-drive",
  "slack", "asana", "discord", "gitlab",
  "notion", "confluence", "datadog", "hubspot", "intercom", "stripe", "zendesk",
  "pagerduty",
  // Wave 1a data-store connectors.
  "postgres", "mongodb", "redis", "elasticsearch",
]);
const EXPECTED_DELETE = EXPECTED_TEST;

describe("connector registry — dashboard allowlist derivation", () => {
  it("auth allowlist matches the legacy literal Set exactly", () => {
    expect(new Set(authAllowedConnectorIds())).toEqual(EXPECTED_AUTH);
  });

  it("connect allowlist matches the legacy literal Set exactly", () => {
    expect(new Set(connectAllowedConnectorIds())).toEqual(EXPECTED_CONNECT);
  });

  it("test allowlist matches the legacy literal Set exactly", () => {
    expect(new Set(testAllowedConnectorIds())).toEqual(EXPECTED_TEST);
  });

  it("delete allowlist matches the legacy literal Set exactly", () => {
    expect(new Set(deleteAllowedConnectorIds())).toEqual(EXPECTED_DELETE);
  });

  it("routes import the registry helpers (not literal Sets)", async () => {
    // Source-level guard: if a future refactor reintroduces a local
    // ALLOWED_CONNECTORS Set, this assertion fails and the test name
    // explains why.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const routes = [
      path.join(here, "..", "route.ts"),
      path.join(here, "..", "auth", "route.ts"),
      path.join(here, "..", "connect", "route.ts"),
      path.join(here, "..", "test", "route.ts"),
    ];
    for (const file of routes) {
      const src = await fs.readFile(file, "utf8");
      expect(src, `${file} must not declare a local ALLOWED_CONNECTORS Set`)
        .not.toMatch(/const\s+ALLOWED_CONNECTORS\s*=\s*new Set/);
      expect(src, `${file} must import from connectorRegistry`)
        .toMatch(/connectorRegistry/);
    }
  });
});
