/**
 * /recipes/install — https:// source recipe-name validation.
 *
 * When a recipe is installed via an https:// source URL, the recipe name is
 * derived from the last path segment. Before the audit fix (2026-06-03
 * MEDIUM #17), no validation was applied to that derived name: a URL like
 * `https://host/recipes/bad%20name.yaml` would extract `bad%20name` and
 * write it into the recipes directory without any sanitisation, opening a
 * path-injection / path-traversal vector.
 *
 * Fix: validate the extracted name against the same SEGMENT_RE used for
 * github: sources and reject with 400 `invalid_recipe_name` before the fetch
 * step is reached.
 *
 * Tests stub `globalThis.fetch` and spy on `dns.lookup` to prevent real
 * network I/O. Pattern mirrors `recipeRoutes-bundle-install.test.ts`.
 */

import dns from "node:dns/promises";
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
const TOKEN = "test-https-install-name-token-0000000000";

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
  vi.restoreAllMocks();
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

const installOptions = {
  method: "POST" as const,
  path: "/recipes/install",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${TOKEN}`,
  },
};

describe("Server /recipes/install — https:// recipe name validation (audit 2026-06-03 MEDIUM #17)", () => {
  it("400 when https:// URL last segment contains URL-encoded chars (e.g. %20)", async () => {
    // Mock DNS to return a public IP so the SSRF guard passes without
    // real network I/O.
    vi.spyOn(dns, "lookup").mockResolvedValue({
      address: "185.199.108.133",
      family: 4,
    } as Awaited<ReturnType<typeof dns.lookup>>);

    // If the fix is not in place, the code reaches the fetch step.
    // Mock fetch to throw so we can distinguish the two code paths:
    //   without fix → 502 fetch_network_error (reached fetch)
    //   with fix    → 400 invalid_recipe_name (rejected before fetch)
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error("should not reach fetch"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const payload = JSON.stringify({
      source:
        "https://raw.githubusercontent.com/user/repo/main/bad%20recipe.yaml",
    });
    const { status, body } = await makeRequest(
      {
        ...installOptions,
        headers: {
          ...installOptions.headers,
          "Content-Length": String(Buffer.byteLength(payload)),
        },
      },
      payload,
    );

    expect(status).toBe(400);
    const json = JSON.parse(body);
    expect(json.ok).toBe(false);
    expect(json.code).toBe("invalid_recipe_name");
    // Fetch must NOT be called — the validation rejects before the fetch
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("400 when https:// URL last segment contains path traversal (..)", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue({
      address: "185.199.108.133",
      family: 4,
    } as Awaited<ReturnType<typeof dns.lookup>>);

    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error("should not reach fetch"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const payload = JSON.stringify({
      source: "https://raw.githubusercontent.com/user/repo/main/..evil.yaml",
    });
    const { status, body } = await makeRequest(
      {
        ...installOptions,
        headers: {
          ...installOptions.headers,
          "Content-Length": String(Buffer.byteLength(payload)),
        },
      },
      payload,
    );

    expect(status).toBe(400);
    const json = JSON.parse(body);
    expect(json.ok).toBe(false);
    expect(json.code).toBe("invalid_recipe_name");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("proceeds past name check when https:// URL has a valid recipe name", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue({
      address: "185.199.108.133",
      family: 4,
    } as Awaited<ReturnType<typeof dns.lookup>>);

    // Valid name: lowercase kebab-case. Fetch returns 404 so we don't
    // need a full YAML — the important thing is the route got past the
    // name validation (status ≠ 400 invalid_recipe_name).
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("Not Found", { status: 404 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const payload = JSON.stringify({
      source:
        "https://raw.githubusercontent.com/user/repo/main/my-valid-recipe.yaml",
    });
    const { status, body } = await makeRequest(
      {
        ...installOptions,
        headers: {
          ...installOptions.headers,
          "Content-Length": String(Buffer.byteLength(payload)),
        },
      },
      payload,
    );

    // Must NOT be 400 invalid_recipe_name — some other status is fine
    // (likely 404 from the mocked upstream).
    expect(status).not.toBe(400);
    const json = JSON.parse(body);
    expect(json.code).not.toBe("invalid_recipe_name");
  });
});
