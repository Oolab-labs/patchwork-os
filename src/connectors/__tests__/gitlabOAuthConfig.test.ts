/**
 * Contract lock for GitLab's OAuth config wiring.
 *
 * GitLab is the third BaseConnector subclass with a real `tokenEndpoint`.
 * Unlike Asana/Discord, GitLab's tokenEndpoint is dynamic — it derives
 * from the configured GitLab instance URL (defaults to gitlab.com,
 * configurable via GITLAB_BASE_URL for self-hosted instances).
 *
 * This test pins both the default-instance URL and the self-hosted
 * override path, so a refactor of the base-URL logic can't silently
 * break refresh against self-hosted GitLab.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitLabConnector } from "../gitlab.js";

type WithGetOAuthConfig = {
  getOAuthConfig(): {
    clientId: string;
    tokenEndpoint: string;
    scopes?: string[];
  } | null;
};

describe("GitLabConnector.getOAuthConfig()", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "patchwork-gitlab-oauth-"));
    process.env.PATCHWORK_HOME = tmpHome;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    delete process.env.GITLAB_CLIENT_ID;
    delete process.env.GITLAB_CLIENT_SECRET;
    delete process.env.GITLAB_BASE_URL;
  });

  afterEach(() => {
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    delete process.env.GITLAB_CLIENT_ID;
    delete process.env.GITLAB_CLIENT_SECRET;
    delete process.env.GITLAB_BASE_URL;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns null when neither env nor stored credentials are present", () => {
    const config = (
      new GitLabConnector() as unknown as WithGetOAuthConfig
    ).getOAuthConfig();
    expect(config).toBeNull();
  });

  it("returns gitlab.com token URL + scopes by default", () => {
    process.env.GITLAB_CLIENT_ID = "test_client_id";
    process.env.GITLAB_CLIENT_SECRET = "test_client_secret";

    const config = (
      new GitLabConnector() as unknown as WithGetOAuthConfig
    ).getOAuthConfig();

    expect(config).not.toBeNull();
    expect(config?.tokenEndpoint).toBe("https://gitlab.com/oauth/token");
    expect(config?.scopes).toEqual([
      "read_user",
      "read_api",
      "read_repository",
    ]);
  });

  it("respects GITLAB_BASE_URL for self-hosted instances", () => {
    process.env.GITLAB_CLIENT_ID = "test_client_id";
    process.env.GITLAB_CLIENT_SECRET = "test_client_secret";
    process.env.GITLAB_BASE_URL = "https://gitlab.example.com";

    const config = (
      new GitLabConnector() as unknown as WithGetOAuthConfig
    ).getOAuthConfig();

    expect(config?.tokenEndpoint).toBe(
      "https://gitlab.example.com/oauth/token",
    );
  });
});
