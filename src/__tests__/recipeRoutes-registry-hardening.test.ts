/**
 * GROUP B3-A — Bridge registry/install hardening (SECURITY).
 *
 * Two units under test, both in `src/recipeRoutes.ts`:
 *
 *  (1) `isWellFormedTemplatesPayload` — must SANITIZE each entry rather than
 *      reject the whole payload. A tampered/future `index.json` entry with an
 *      out-of-enum `risk_level` (e.g. "critical" | null | 42), an out-of-enum
 *      `approval_behavior`, or a non-numeric `downloads` must have those fields
 *      stripped to `undefined` (or coerced to a number) while the entry itself
 *      is retained. Goal: one malformed entry cannot poison the 5-minute
 *      registry cache for every client, and an out-of-enum risk never silently
 *      reads as "safe" downstream.
 *
 *  (2) `fetchFollowingRedirectsSafely` — post-redirect SSRF re-check on the
 *      non-github HTTPS install path. A 302 whose `Location` points at a
 *      private/loopback host must be rejected WITHOUT the loop following to the
 *      private host (the upfront `validateSafeUrl` only pins the first hop).
 */

import { describe, expect, it, vi } from "vitest";
import {
  fetchFollowingRedirectsSafely,
  isWellFormedTemplatesPayload,
} from "../recipeRoutes.js";

describe("isWellFormedTemplatesPayload — enum/field sanitization (B3-A.1)", () => {
  it("strips out-of-enum risk_level and non-numeric downloads but keeps the entry", () => {
    const payload = {
      recipes: [
        {
          slug: "evil",
          name: "Evil Recipe",
          // Out-of-enum: must NOT survive as "critical" downstream.
          risk_level: "critical",
          // Out-of-enum: must be stripped.
          approval_behavior: "auto_approve_everything",
          // Non-numeric: must be coerced/dropped — never passed through as a string.
          downloads: "abc",
        },
      ],
    };

    const ok = isWellFormedTemplatesPayload(payload);
    expect(ok).toBe(true);

    const entry = payload.recipes[0] as Record<string, unknown>;
    // Entry retained.
    expect(entry).toBeDefined();
    expect(entry.slug).toBe("evil");
    // Out-of-enum risk_level stripped — must not silently read as a valid level.
    expect(entry.risk_level).toBeUndefined();
    // Out-of-enum approval_behavior stripped.
    expect(entry.approval_behavior).toBeUndefined();
    // Non-numeric downloads must not remain a string.
    expect(typeof entry.downloads).not.toBe("string");
    expect(entry.downloads).toBeUndefined();
  });

  it("keeps valid enum + numeric fields untouched", () => {
    const payload = {
      recipes: [
        {
          slug: "good",
          risk_level: "low",
          approval_behavior: "always_ask",
          downloads: 42,
        },
      ],
    };
    const ok = isWellFormedTemplatesPayload(payload);
    expect(ok).toBe(true);
    const entry = payload.recipes[0] as Record<string, unknown>;
    expect(entry.risk_level).toBe("low");
    expect(entry.approval_behavior).toBe("always_ask");
    expect(entry.downloads).toBe(42);
  });
});

describe("fetchFollowingRedirectsSafely — post-redirect SSRF re-check (B3-A.2)", () => {
  it("rejects a 302 whose Location points at a loopback host, without following", () => {
    const followed: string[] = [];
    const fakeFetch = vi.fn(async (url: string) => {
      followed.push(url);
      if (url === "https://example.org/recipe.yaml") {
        return {
          ok: false,
          status: 302,
          statusText: "Found",
          headers: new Headers({ location: "https://127.0.0.1/evil.yaml" }),
          body: null,
        } as unknown as Response;
      }
      // Any actual fetch of the private host means the guard FAILED.
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        body: null,
      } as unknown as Response;
    });

    return expect(
      fetchFollowingRedirectsSafely("https://example.org/recipe.yaml", {
        fetchImpl: fakeFetch as unknown as typeof fetch,
      }),
    )
      .rejects.toThrow(/ssrf|private|blocked/i)
      .then(() => {
        // The private-host hop must never have been fetched.
        expect(followed).not.toContain("https://127.0.0.1/evil.yaml");
        expect(followed).toEqual(["https://example.org/recipe.yaml"]);
      });
  });

  it("rejects a 302 to a private RFC-1918 host", async () => {
    const followed: string[] = [];
    const fakeFetch = vi.fn(async (url: string) => {
      followed.push(url);
      return {
        ok: false,
        status: 302,
        statusText: "Found",
        headers: new Headers({ location: "https://10.0.0.5/x.yaml" }),
        body: null,
      } as unknown as Response;
    });
    await expect(
      fetchFollowingRedirectsSafely("https://example.org/recipe.yaml", {
        fetchImpl: fakeFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/ssrf|private|blocked/i);
    expect(followed).not.toContain("https://10.0.0.5/x.yaml");
  });

  it("caps the redirect chain at 5 hops", async () => {
    let n = 0;
    const fakeFetch = vi.fn(async (_url: string) => {
      n += 1;
      // Always redirect to another public host → never terminates on its own.
      return {
        ok: false,
        status: 302,
        statusText: "Found",
        headers: new Headers({ location: `https://example.org/hop-${n}.yaml` }),
        body: null,
      } as unknown as Response;
    });
    await expect(
      fetchFollowingRedirectsSafely("https://example.org/start.yaml", {
        fetchImpl: fakeFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/redirect/i);
  });

  it("returns the terminal response on a non-redirect status", async () => {
    const terminal = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      body: null,
    } as unknown as Response;
    const fakeFetch = vi.fn(async () => terminal);
    const res = await fetchFollowingRedirectsSafely(
      "https://example.org/recipe.yaml",
      { fetchImpl: fakeFetch as unknown as typeof fetch },
    );
    expect(res.status).toBe(200);
  });
});
