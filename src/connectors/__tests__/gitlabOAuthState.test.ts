/**
 * Audit 2026-06-08 (connectors-core-3): GitLab was the last OAuth connector
 * still using an unbounded module-scope `Set<string>` + per-entry setTimeout
 * for its CSRF state, instead of the shared `createOAuthStateStore` (hard size
 * cap + namespaced disk persistence) every other connector uses.
 *
 * The discriminating behaviour is persistence across a bridge restart: with the
 * old in-memory Set, a state issued before a restart is lost and the callback
 * rejects with "invalid or expired state". With the namespaced store it is
 * reloaded from disk and accepted.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "patchwork-gitlab-state-"));
  mkdirSync(join(tmpHome, "tokens"), { recursive: true });
  process.env.PATCHWORK_HOME = tmpHome;
  process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
  process.env.GITLAB_CLIENT_ID = "gitlab-client";
  process.env.GITLAB_CLIENT_SECRET = "gitlab-secret";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.PATCHWORK_HOME;
  delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  delete process.env.GITLAB_CLIENT_ID;
  delete process.env.GITLAB_CLIENT_SECRET;
  vi.unstubAllGlobals();
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
});

function stateFromRedirect(redirect: string | undefined): string {
  const url = new URL(redirect ?? "");
  const state = url.searchParams.get("state");
  if (!state) throw new Error("no state in authorize redirect");
  return state;
}

describe("GitLab OAuth state store", () => {
  it("rejects an unknown state", async () => {
    const { handleGitLabCallback } = await import("../gitlab.js");
    const res = await handleGitLabCallback("code", "never-issued", null);
    expect(res.body).toContain("invalid or expired state");
  });

  it("accepts a state issued before a simulated restart (persisted to disk)", async () => {
    // Instance A issues the state.
    const a = await import("../gitlab.js");
    const auth = a.handleGitLabAuthorize();
    const state = stateFromRedirect(auth.redirect);

    // Simulate a bridge restart: fresh module instance (new in-memory map).
    vi.resetModules();
    // Token exchange must not hit the network; make it fail so the callback
    // does NOT persist tokens — we only care that the state was accepted.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 400 })),
    );
    const b = await import("../gitlab.js");
    const res = await b.handleGitLabCallback("the-code", state, null);

    // Old Set-based impl would reject here; the persisted store accepts it and
    // moves on to (a deliberately-failing) token exchange.
    expect(res.body).not.toContain("invalid or expired state");
  });

  it("is single-use — the same state cannot be consumed twice", async () => {
    const mod = await import("../gitlab.js");
    const auth = mod.handleGitLabAuthorize();
    const state = stateFromRedirect(auth.redirect);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 400 })),
    );
    const first = await mod.handleGitLabCallback("code-1", state, null);
    expect(first.body).not.toContain("invalid or expired state");

    const second = await mod.handleGitLabCallback("code-2", state, null);
    expect(second.body).toContain("invalid or expired state");
  });
});
