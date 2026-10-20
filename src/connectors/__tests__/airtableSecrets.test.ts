/**
 * Airtable reads its credentials through `readSecret`, like every other
 * connector since #1702 (Private/52 LOW).
 *
 * It read `process.env` directly, so a value in the secrets file was never
 * used, and rotating the file had no effect until the operator also changed
 * the environment and restarted. Real secrets file in a temp PATCHWORK_HOME;
 * only `fetch` is faked.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "airtable-secrets-"));
  vi.stubEnv("PATCHWORK_HOME", home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("PATCHWORK_TOKEN_STORAGE_BACKEND", "file");
  vi.stubEnv("AIRTABLE_CLIENT_ID", "");
  vi.stubEnv("AIRTABLE_CLIENT_SECRET", "");
  vi.stubEnv("AIRTABLE_ACCESS_TOKEN", "");
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

function writeSecrets(values: Record<string, string>) {
  writeFileSync(join(home, ".secrets.json"), JSON.stringify(values));
}

type Internals = {
  getOAuthConfig(): { clientId: string; clientSecret?: string } | null;
  _oauthRefresh(t: Record<string, unknown>): Promise<unknown>;
};

async function connector(): Promise<Internals> {
  const { AirtableConnector } = await import("../airtable.js");
  return new AirtableConnector() as unknown as Internals;
}

describe("airtable credentials come from the secrets file", () => {
  it("OAuth config uses the client id and secret from the file", async () => {
    writeSecrets({
      AIRTABLE_CLIENT_ID: "cid-file",
      AIRTABLE_CLIENT_SECRET: "cs-file",
    });
    const cfg = (await connector()).getOAuthConfig();
    expect(cfg?.clientId).toBe("cid-file");
    expect(cfg?.clientSecret).toBe("cs-file");
  });

  it("a refresh presents the CURRENT secret after the file is rotated", async () => {
    const auth: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: RequestInit) => {
        auth.push(
          String((init?.headers as Record<string, string>)?.Authorization),
        );
        return {
          ok: false,
          status: 400,
          json: async () => ({}),
          text: async () => "{}",
        };
      }),
    );
    const c = await connector();
    writeSecrets({
      AIRTABLE_CLIENT_ID: "cid",
      AIRTABLE_CLIENT_SECRET: "cs-old",
    });
    await c._oauthRefresh({ refreshToken: "rt" }).catch(() => undefined);
    // A different size guarantees a new file identity for the reload check.
    writeSecrets({
      AIRTABLE_CLIENT_ID: "cid",
      AIRTABLE_CLIENT_SECRET: "cs-rotated-now",
    });
    await c._oauthRefresh({ refreshToken: "rt" }).catch(() => undefined);
    const decode = (h: string) =>
      Buffer.from(h.replace(/^Basic /, ""), "base64").toString();
    expect(auth.map(decode)).toEqual(["cid:cs-old", "cid:cs-rotated-now"]);
  });

  it("an access token in the file is used", async () => {
    writeSecrets({ AIRTABLE_ACCESS_TOKEN: "pat-file" });
    const { loadRawTokens } = await import("../airtable.js");
    expect(
      (loadRawTokens() as { accessToken?: string } | null)?.accessToken,
    ).toBe("pat-file");
  });
});
