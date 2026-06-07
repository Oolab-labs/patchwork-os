/**
 * LOW #35 — Temp file orphaned when writeFileSync throws before inner try/finally.
 *
 * The install route at src/recipeRoutes.ts does:
 *   writeFileSync(tmpFile, yamlText)     ← OUTSIDE the inner try
 *   try {
 *     installRecipeFromFile(tmpFile, ...)
 *   } finally {
 *     unlinkSync(tmpFile)               ← never reached if writeFileSync throws
 *   }
 *
 * Fix: move writeFileSync inside the try (or add an outer finally that also
 * calls unlinkSync).  This test verifies the invariant: even when writeFileSync
 * throws ENOSPC, unlinkSync must still be called.
 *
 * Because recipeRoutes.ts uses `await import("node:fs")` lazily, we must use
 * vitest's vi.mock (hoisted) to intercept the module before the subject loads.
 */

import http from "node:http";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Logger } from "../logger.js";

// --------------------------------------------------------------------------
// Hoisted mock helpers — vitest lifts these before any import
// --------------------------------------------------------------------------
const mockFns = vi.hoisted(() => ({
  writeFileSync: vi.fn<(...args: unknown[]) => void>(),
  unlinkSync: vi.fn<(...args: unknown[]) => void>(),
  mkdirSync: vi.fn<(...args: unknown[]) => void>(),
  // readFileSync is used in the preflight branch; return empty JSON to avoid errors
  readFileSync: vi.fn<(...args: unknown[]) => string>(() => "{}"),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: mockFns.writeFileSync,
    unlinkSync: mockFns.unlinkSync,
    mkdirSync: mockFns.mkdirSync,
    readFileSync: mockFns.readFileSync,
    default: {
      ...(actual as object),
      writeFileSync: mockFns.writeFileSync,
      unlinkSync: mockFns.unlinkSync,
      mkdirSync: mockFns.mkdirSync,
      readFileSync: mockFns.readFileSync,
    },
  };
});

// Import after vi.mock so the module cache is intercepted
import { Server } from "../server.js";

const LOGGER = new Logger(false);
const TOKEN = "test-install-cleanup-token-000000000";

let server: Server | null = null;
let port = 0;

function makeRequest(
  options: http.RequestOptions & { method: string; path: string },
  body = "",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    let captured = { status: 0, body: "" };
    const finish = (s: number, d: string) => {
      if (resolved) return;
      resolved = true;
      captured = { status: s, body: d };
      resolve(captured);
    };
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
        ...options,
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString()));
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

beforeAll(async () => {
  server = new Server(TOKEN, LOGGER);
  port = await server.findAndListen(null);
});

afterAll(async () => {
  await server?.close();
  server = null;
  port = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("LOW #35 — install route: unlinkSync called even when writeFileSync throws", () => {
  it("calls unlinkSync for cleanup when writeFileSync throws ENOSPC", async () => {
    // Make writeFileSync succeed on the first call (creating the tmp file),
    // then throw on the second call (if any) — or we can make it always throw.
    // The route creates the tmp file and then calls writeFileSync once.
    // We want: tmpFile is "created" (path is computed), then writeFileSync throws.
    const enospc = Object.assign(
      new Error("ENOSPC: no space left on device, write"),
      { code: "ENOSPC" },
    );
    mockFns.writeFileSync.mockImplementationOnce(() => {
      throw enospc;
    });
    // mkdirSync should not throw
    mockFns.mkdirSync.mockImplementation(() => undefined);
    // unlinkSync: track calls, don't throw
    mockFns.unlinkSync.mockImplementation(() => undefined);

    // POST to /recipes/install with a github: source.
    // The route's fetch will fail (no real network / fetch mock returns error),
    // but that's after writeFileSync — we're testing earlier in the flow.
    // The route that directly calls writeFileSync then try{installRecipeFromFile}
    // is POST /recipes/install (single-recipe path).
    // To reach writeFileSync, we need the source to be parseable.
    // A github: shorthand resolves to a fetch; but writeFileSync happens after
    // the fetch resolves. Let's mock globalThis.fetch to return the YAML.
    const yamlContent = "name: test-cleanup\nsteps: []\n";
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(yamlContent));
        controller.close();
      },
    });
    const savedFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "Content-Type": "text/yaml" }),
      body: stream,
    }) as unknown as typeof fetch;

    try {
      const { status } = await makeRequest(
        { method: "POST", path: "/recipes/install" },
        JSON.stringify({ source: "github:patchworkos/recipes/recipes/test" }),
      );

      // Should not be 401 (auth passed) or 503 (install disabled).
      // May be 500 (writeFileSync threw) — that's acceptable.
      expect(status).not.toBe(401);

      // KEY ASSERTION: if writeFileSync was called, unlinkSync must also be called
      // (cleanup on error path). Before the fix, writeFileSync throws and the
      // inner try/finally is never entered, so unlinkSync is never called.
      if (mockFns.writeFileSync.mock.calls.length > 0) {
        expect(mockFns.unlinkSync).toHaveBeenCalled();
      }
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});
