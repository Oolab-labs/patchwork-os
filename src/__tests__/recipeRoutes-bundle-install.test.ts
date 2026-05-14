/**
 * /recipes/install — bundle-source dispatch tests (#130 PR A).
 *
 * Covers the new branch that recognizes
 * `github:patchworkos/recipes/bundles/<name>` sources, fetches
 * `patchwork-bundle.json`, and installs each declared recipe.
 *
 * Tests focus on failure paths + the advisory surface — the per-recipe
 * install side effect (writing into `~/.patchwork/recipes/`) is already
 * covered by `recipeRoutes-install.test.ts` for the canonical
 * `github:patchworkos/recipes/recipes/<name>` path. The bundle handler
 * reuses that same `installRecipeFromFile` helper, so happy-path
 * coverage there transfers.
 *
 * Tests stub `globalThis.fetch` to fully control upstream responses;
 * no real network IO. Pattern mirrors `recipeRoutes-install.test.ts`.
 */

import http from "node:http";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const logger = new Logger(false);
const TOKEN = "test-bundle-install-token-0000000000000000";

let server: Server | null = null;
let port = 0;
const originalFetch = globalThis.fetch;

function makeRequest(
  options: http.RequestOptions,
  body = "",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const finish = (status: number, data: string) => {
      if (resolved) return;
      resolved = true;
      resolve({ status, body: data });
    };
    const req = http.request(
      { hostname: "127.0.0.1", port, ...options },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk));
        res.on("end", () => finish(res.statusCode ?? 0, data));
        res.on("error", () => finish(res.statusCode ?? 0, data));
        res.on("close", () => finish(res.statusCode ?? 0, data));
      },
    );
    req.on("error", (err) => {
      if (resolved) return;
      reject(err);
    });
    if (body) req.write(body);
    req.end();
  });
}

beforeAll(() => {
  // Don't let host-environment env var leak into tests (matches
  // recipeRoutes-install.test.ts pattern — same Server instance).
  delete process.env.CLAUDE_IDE_BRIDGE_INSTALL_ALLOWED_HOSTS;
});

beforeEach(async () => {
  server = new Server(TOKEN, logger);
  port = await server.findAndListen(null);
});

afterEach(async () => {
  await server?.close();
  server = null;
  port = 0;
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

const installPath = {
  method: "POST" as const,
  path: "/recipes/install",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${TOKEN}`,
  },
};

describe("Server /recipes/install — bundle dispatch (#130 PR A)", () => {
  it("rejects bundle name with path traversal → 400", async () => {
    const { status, body } = await makeRequest(
      installPath,
      JSON.stringify({
        source: "github:patchworkos/recipes/bundles/../etc/passwd",
      }),
    );
    expect(status).toBe(400);
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(false);
    // Post org-allowlist refactor: the shared parser validates segment
    // shape first, so traversal in the bundle name now lands as
    // bad_shape (too many `/` segments) rather than the legacy
    // invalid_bundle_name. Accept either to stay forward-compatible.
    expect(["bad_shape", "bad_segment", "invalid_bundle_name"]).toContain(
      parsed.code,
    );
  });

  it("returns 404 when bundle manifest is not found upstream", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
    const { status, body } = await makeRequest(
      installPath,
      JSON.stringify({
        source: "github:patchworkos/recipes/bundles/missing-bundle",
      }),
    );
    expect(status).toBe(404);
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("bundle_fetch_upstream_error");
    expect(parsed.upstreamStatus).toBe(404);
  });

  it("returns 502 when manifest body is not valid JSON", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("not json at all", { status: 200 }));
    const { status, body } = await makeRequest(
      installPath,
      JSON.stringify({
        source: "github:patchworkos/recipes/bundles/broken",
      }),
    );
    expect(status).toBe(502);
    const parsed = JSON.parse(body);
    expect(parsed.code).toBe("bundle_manifest_invalid_json");
  });

  it("returns 400 when manifest has no recipes field", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ name: "x", description: "y" }), {
        status: 200,
      }),
    );
    const { status, body } = await makeRequest(
      installPath,
      JSON.stringify({
        source: "github:patchworkos/recipes/bundles/no-recipes",
      }),
    );
    expect(status).toBe(400);
    const parsed = JSON.parse(body);
    expect(parsed.code).toBe("bundle_manifest_invalid_recipes");
  });

  it("returns 400 when manifest recipes has unsafe entries", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          name: "x",
          recipes: ["good-recipe", "../../../etc/passwd"],
        }),
        { status: 200 },
      ),
    );
    const { status, body } = await makeRequest(
      installPath,
      JSON.stringify({
        source: "github:patchworkos/recipes/bundles/sneaky",
      }),
    );
    expect(status).toBe(400);
    const parsed = JSON.parse(body);
    expect(parsed.code).toBe("bundle_manifest_invalid_recipes");
  });

  it("returns 400 when manifest recipes is an empty array", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ name: "x", recipes: [] }), {
        status: 200,
      }),
    );
    const { status, body } = await makeRequest(
      installPath,
      JSON.stringify({
        source: "github:patchworkos/recipes/bundles/empty",
      }),
    );
    expect(status).toBe(400);
    const parsed = JSON.parse(body);
    expect(parsed.code).toBe("bundle_manifest_invalid_recipes");
  });

  it("returns 502 + plugin advisory when all recipes fail upstream", async () => {
    // First fetch = manifest (succeeds, declares 1 recipe + a plugin).
    // Second fetch = recipe yaml (404). All recipes failed → 502.
    // Advisory still surfaced so caller knows about the plugin.
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: "x",
            recipes: ["only-recipe"],
            plugin: "@example/plugin",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
    const { status, body } = await makeRequest(
      installPath,
      JSON.stringify({
        source: "github:patchworkos/recipes/bundles/all-fail",
      }),
    );
    expect(status).toBe(502);
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe("bundle");
    expect(parsed.installed).toEqual([]);
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0].name).toBe("only-recipe");
    expect(parsed.advisory.plugin).toMatch(/@example\/plugin/);
  });

  it("returns 413 when manifest exceeds 64 KB", async () => {
    const huge = "x".repeat(70_000);
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(huge, { status: 200 }));
    const { status, body } = await makeRequest(
      installPath,
      JSON.stringify({
        source: "github:patchworkos/recipes/bundles/huge",
      }),
    );
    expect(status).toBe(413);
    const parsed = JSON.parse(body);
    expect(parsed.code).toBe("bundle_manifest_too_large");
  });
});
