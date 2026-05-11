/**
 * Contract lock for Asana's OAuth config wiring.
 *
 * Asana is one of the three BaseConnector subclasses that ship with a
 * real `tokenEndpoint` (others: Discord, GitLab). The Wave-2 plan's
 * "remaining gap" was lack of per-provider coverage beyond the generic
 * BaseConnector tests — this file locks the provider-specific surface
 * for Asana.
 *
 * What's tested:
 *   1. Returns null when neither env nor stored credentials are present
 *      (the refresh path must be unreachable in that case).
 *   2. Returns the canonical Asana token URL + scope set when env
 *      credentials are present (pins the constants so a refactor can't
 *      silently change them).
 *
 * Generic refresh-flow behavior (401 → clear, 5xx → preserve, etc.) is
 * covered by baseConnector.test.ts against a TestConnector subclass.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AsanaConnector } from "../asana.js";

type WithGetOAuthConfig = {
  getOAuthConfig(): {
    clientId: string;
    tokenEndpoint: string;
    scopes?: string[];
  } | null;
};

const ASANA_CANONICAL_TOKEN_URL = "https://app.asana.com/-/oauth_token";

describe("AsanaConnector.getOAuthConfig()", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "patchwork-asana-oauth-"));
    process.env.PATCHWORK_HOME = tmpHome;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    delete process.env.ASANA_CLIENT_ID;
    delete process.env.ASANA_CLIENT_SECRET;
  });

  afterEach(() => {
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    delete process.env.ASANA_CLIENT_ID;
    delete process.env.ASANA_CLIENT_SECRET;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns null when neither env nor stored credentials are present", () => {
    const config = (
      new AsanaConnector() as unknown as WithGetOAuthConfig
    ).getOAuthConfig();
    expect(config).toBeNull();
  });

  it("returns canonical token URL + scopes when env credentials are present", () => {
    process.env.ASANA_CLIENT_ID = "test_client_id";
    process.env.ASANA_CLIENT_SECRET = "test_client_secret";

    const config = (
      new AsanaConnector() as unknown as WithGetOAuthConfig
    ).getOAuthConfig();

    expect(config).not.toBeNull();
    expect(config?.tokenEndpoint).toBe(ASANA_CANONICAL_TOKEN_URL);
    expect(config?.scopes).toEqual(["default"]);
    expect(config?.clientId).toBe("test_client_id");
  });
});
