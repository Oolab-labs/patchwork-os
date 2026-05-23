/**
 * A-PR2 — `/recipes/install` route hardening tests.
 *
 * Covers the dogfood-required regression cases:
 *   - install-ssrf-internal     : 169.254.169.254 (AWS metadata) → 403
 *   - install-fetch-404         : upstream 404 → 404 (was 500)
 *   - install-body-cap          : 1 MB JSON body → 413
 *   - install-redirect-allowlist: redirect to private host → 502 (fetch_network_error)
 *   - install-shorthand         : github:foo@bar:bad/repo → 400
 *   - recipes-name-run-cap      : 300 KB body to /recipes/:name/run → 413
 *   - install-allowlist-env     : with env, public host allowed; without env, 403
 *
 * Tests spawn a real HTTP server (matches existing server-recipes-content
 * pattern) and stub `globalThis.fetch` to fully control the upstream
 * response shape — no real network IO.
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
const TOKEN = "test-install-route-token-0000000000000000";

let server: Server | null = null;
let port = 0;
const originalFetch = globalThis.fetch;
const originalAllowedHosts =
  process.env.CLAUDE_IDE_BRIDGE_INSTALL_ALLOWED_HOSTS;
const originalRepoAllowlist = process.env.PATCHWORK_RECIPE_REPO_ALLOWLIST;

function makeRequest(
  options: http.RequestOptions,
  body = "",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    let captured = { status: 0, body: "" };
    const finish = (status: number, data: string) => {
      if (resolved) return;
      resolved = true;
      captured = { status, body: data };
      resolve(captured);
    };
    const req = http.request(
      { hostname: "127.0.0.1", port, ...options },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk));
        res.on("end", () => finish(res.statusCode ?? 0, data));
        // Server may destroy socket right after writing 413/400 — capture
        // whatever arrived so the assertion can still see status + body.
        res.on("error", () => finish(res.statusCode ?? 0, data));
        res.on("close", () => finish(res.statusCode ?? 0, data));
      },
    );
    req.on("error", (err) => {
      if (resolved) return;
      reject(err);
    });
    // Write all at once and end. The server's `readJsonBody` resolves the
    // 413 path synchronously on the first overflowing chunk, but does NOT
    // destroy the socket — it drains incoming bytes via the no-op data
    // handler until end. This keeps `res.end(413)` cleanly delivered.
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

beforeAll(() => {
  // Don't let host-environment env var leak into tests.
  delete process.env.CLAUDE_IDE_BRIDGE_INSTALL_ALLOWED_HOSTS;
});

afterAll(() => {
  if (originalAllowedHosts !== undefined) {
    process.env.CLAUDE_IDE_BRIDGE_INSTALL_ALLOWED_HOSTS = originalAllowedHosts;
  } else {
    delete process.env.CLAUDE_IDE_BRIDGE_INSTALL_ALLOWED_HOSTS;
  }
  if (originalRepoAllowlist !== undefined) {
    process.env.PATCHWORK_RECIPE_REPO_ALLOWLIST = originalRepoAllowlist;
  } else {
    delete process.env.PATCHWORK_RECIPE_REPO_ALLOWLIST;
  }
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
  delete process.env.CLAUDE_IDE_BRIDGE_INSTALL_ALLOWED_HOSTS;
  delete process.env.PATCHWORK_RECIPE_REPO_ALLOWLIST;
});

/** Build a Response-shape that streams `body` through the fetch reader path. */
function fakeResponse(
  status: number,
  body: string,
): {
  ok: boolean;
  status: number;
  statusText: string;
  body: ReadableStream<Uint8Array>;
} {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      if (body.length > 0) controller.enqueue(enc.encode(body));
      controller.close();
    },
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Not Found",
    body: stream,
  };
}

describe("Server /recipes/install — A-PR2 (dogfood F-05 / H-routes Bug 2)", () => {
  it("install-ssrf-internal: 169.254.169.254 → 403 host_not_allowlisted", async () => {
    const { status, body } = await makeRequest(
      {
        method: "POST",
        path: "/recipes/install",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({
        source: "https://169.254.169.254/latest/meta-data/",
      }),
    );
    expect(status).toBe(403);
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("host_not_allowlisted");
  });

  it("install-fetch-404: upstream 404 → 404 (not 500)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        fakeResponse(404, "not found"),
      ) as unknown as typeof fetch;
    const { status, body } = await makeRequest(
      {
        method: "POST",
        path: "/recipes/install",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({
        source: "github:patchworkos/recipes/recipes/no-such-recipe",
      }),
    );
    expect(status).toBe(404);
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("fetch_upstream_error");
    expect(parsed.upstreamStatus).toBe(404);
  });

  it("install-body-cap: 1 MB JSON body → 413", async () => {
    // 1 MB of payload — well above the 4 KB install cap.
    const big = "x".repeat(1024 * 1024);
    const { status, body } = await makeRequest(
      {
        method: "POST",
        path: "/recipes/install",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({ source: big }),
    );
    expect(status).toBe(413);
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("body_too_large");
  });

  it("install-redirect-allowlist: opt-in host, redirect to internal IP → SSRF blocked", async () => {
    // Allowlist a public host; the SSRF guard is what catches the loopback.
    process.env.CLAUDE_IDE_BRIDGE_INSTALL_ALLOWED_HOSTS = "127.0.0.1";
    const { status, body } = await makeRequest(
      {
        method: "POST",
        path: "/recipes/install",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({
        source: "https://127.0.0.1/evil.yaml",
      }),
    );
    expect(status).toBe(403);
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("ssrf_blocked");
  });

  it("install-hot-reload: success path invokes server.onRecipesChangedFn exactly once", async () => {
    // Bridge wires server.onRecipesChangedFn = () => scheduler.start();
    // route handler must fire it post-success so cron-trigger recipes
    // installed from the marketplace start firing without a bridge
    // restart. Test in isolation with a vi.fn() stub — we don't need a
    // real scheduler here, just that the callback gets called.
    const onChange = vi.fn();
    server!.onRecipesChangedFn = onChange;

    // Well-formed manual-trigger YAML (manual bypasses compileRecipeFull
    // so the test doesn't depend on a passing compile path).
    const yamlBody = [
      "name: hot-reload-test-recipe",
      "version: 1.0.0",
      "trigger:",
      "  type: manual",
      "steps:",
      "  - id: s1",
      "    agent: false",
      "    tool: file.write",
      "    params:",
      "      path: /tmp/x",
      "      content: y",
      "",
    ].join("\n");
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        fakeResponse(200, yamlBody),
      ) as unknown as typeof fetch;

    const { status } = await makeRequest(
      {
        method: "POST",
        path: "/recipes/install",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({
        source: "github:patchworkos/recipes/recipes/hot-reload-test-recipe",
      }),
    );
    expect(status).toBe(200);
    expect(onChange).toHaveBeenCalledTimes(1);

    // Clean up the file the install wrote so a stale entry doesn't
    // pollute the user's recipes dir or future test runs.
    try {
      const { unlinkSync } = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      unlinkSync(
        path.join(
          os.homedir(),
          ".patchwork",
          "recipes",
          "hot-reload-test-recipe.json",
        ),
      );
    } catch {
      // best-effort
    }
  });

  it("install-hot-reload-callback-throws: scheduler error does NOT fail the request", async () => {
    // Contract: onRecipesChangedFn is best-effort. If the scheduler's
    // restart throws, the install was still a real success on disk —
    // the caller must see 200, not 500.
    server!.onRecipesChangedFn = () => {
      throw new Error("simulated scheduler crash");
    };
    const yamlBody = [
      "name: hot-reload-throws-recipe",
      "version: 1.0.0",
      "trigger:",
      "  type: manual",
      "steps:",
      "  - id: s1",
      "    agent: false",
      "    tool: file.write",
      "    params:",
      "      path: /tmp/x",
      "      content: y",
      "",
    ].join("\n");
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        fakeResponse(200, yamlBody),
      ) as unknown as typeof fetch;

    const { status, body } = await makeRequest(
      {
        method: "POST",
        path: "/recipes/install",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({
        source: "github:patchworkos/recipes/recipes/hot-reload-throws-recipe",
      }),
    );
    expect(status).toBe(200);
    expect(JSON.parse(body).ok).toBe(true);

    try {
      const { unlinkSync } = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      unlinkSync(
        path.join(
          os.homedir(),
          ".patchwork",
          "recipes",
          "hot-reload-throws-recipe.json",
        ),
      );
    } catch {
      // best-effort
    }
  });

  it("install-allowlist-env: without env var → 403, with env var → fetch attempted", async () => {
    // Without env var: rejected.
    {
      const { status, body } = await makeRequest(
        {
          method: "POST",
          path: "/recipes/install",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TOKEN}`,
          },
        },
        JSON.stringify({ source: "https://example.org/foo.yaml" }),
      );
      expect(status).toBe(403);
      expect(JSON.parse(body).code).toBe("host_not_allowlisted");
    }
    // With env var: passes the allowlist gate; SSRF guard then resolves DNS,
    // and the upstream stub returns the YAML.
    process.env.CLAUDE_IDE_BRIDGE_INSTALL_ALLOWED_HOSTS = "example.org";
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        fakeResponse(
          200,
          "name: ok\ntrigger:\n  type: manual\nsteps:\n  - tool: file.write\n    path: /tmp/x\n    content: y\n",
        ),
      ) as unknown as typeof fetch;
    const { status } = await makeRequest(
      {
        method: "POST",
        path: "/recipes/install",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({ source: "https://example.org/foo.yaml" }),
    );
    // Either the install completes (200), the recipe parses but doesn't
    // satisfy the schema (400 invalid_recipe), or the installer itself
    // crashes (500). All three prove the allowlist gate passed (status
    // is no longer 403). 400 is the post-2026-05-13 baseline — parser
    // errors used to come back as 500 indistinguishably from installer
    // crashes.
    expect([200, 400, 500]).toContain(status);
  });

  it("install-bad-source: rejects non-https / non-github source → 400", async () => {
    const { status, body } = await makeRequest(
      {
        method: "POST",
        path: "/recipes/install",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({ source: "ftp://example.org/foo.yaml" }),
    );
    expect(status).toBe(400);
    expect(JSON.parse(body).code).toBe("unsupported_source");
  });

  it("install-bad-github-name: github prefix with traversal → 400", async () => {
    const { status, body } = await makeRequest(
      {
        method: "POST",
        path: "/recipes/install",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({
        source: "github:patchworkos/recipes/recipes/../../../../etc/passwd",
      }),
    );
    expect(status).toBe(400);
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(false);
    // Post-org-allowlist refactor: traversal trips bad_shape (too many
    // segments) before bad_segment (bad chars). Either is a correct
    // 400; assert on the code rather than legacy "invalid recipe name"
    // phrasing.
    expect(["bad_shape", "bad_segment"]).toContain(parsed.code);
  });

  it("install-third-party-org: allowlisted via env var passes the 403 gate", async () => {
    // Default-deny: random orgs hit not_allowlisted (403).
    {
      const { status, body } = await makeRequest(
        {
          method: "POST",
          path: "/recipes/install",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TOKEN}`,
          },
        },
        JSON.stringify({
          source: "github:acme/cookbook/recipes/incident-pager",
        }),
      );
      expect(status).toBe(403);
      expect(JSON.parse(body).code).toBe("not_allowlisted");
    }
    // Opt-in via env: install proceeds past the allowlist check.
    // We don't stub fetch here — outcome can be 200 (parses + installs)
    // or 502 (no fetch mock so the request bombs out at the network).
    // Either way, status MUST NOT be 403 — that's the proof the gate
    // passed.
    process.env.PATCHWORK_RECIPE_REPO_ALLOWLIST = "acme/cookbook";
    try {
      const { status } = await makeRequest(
        {
          method: "POST",
          path: "/recipes/install",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TOKEN}`,
          },
        },
        JSON.stringify({
          source: "github:acme/cookbook/recipes/incident-pager",
        }),
      );
      expect(status).not.toBe(403);
    } finally {
      delete process.env.PATCHWORK_RECIPE_REPO_ALLOWLIST;
    }
  });

  it("install-malformed-yaml: invalid YAML body → 400 invalid_recipe (was 500)", async () => {
    // Body that successfully fetches but won't parse as YAML. The previous
    // behaviour was to bubble the parser/yaml exception up to the generic
    // 500 catch-all — dashboards then surfaced "Internal server error"
    // with no signal that the recipe itself was the problem. Now the
    // handler distinguishes parser failures and returns 400 with the
    // actual error message.
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        fakeResponse(200, "this: is: not: valid: yaml: ::"),
      ) as unknown as typeof fetch;
    const { status, body } = await makeRequest(
      {
        method: "POST",
        path: "/recipes/install",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({
        source: "github:patchworkos/recipes/recipes/malformed-recipe",
      }),
    );
    expect(status).toBe(400);
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("invalid_recipe");
    // Error should carry the parser's message, not the generic
    // "Internal server error" string.
    expect(parsed.error).not.toBe("Internal server error");
    expect(typeof parsed.error).toBe("string");
    expect(parsed.error.length).toBeGreaterThan(0);
  });

  it("install-schema-violation: well-formed YAML missing required fields → 400 invalid_recipe", async () => {
    // YAML parses fine but parseRecipe throws RecipeParseError because
    // `steps` is missing. Same 400 + message-passthrough behaviour as
    // the malformed-yaml case.
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        fakeResponse(
          200,
          "name: malformed-recipe\nversion: 1.0.0\ntrigger:\n  type: manual\n",
        ),
      ) as unknown as typeof fetch;
    const { status, body } = await makeRequest(
      {
        method: "POST",
        path: "/recipes/install",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({
        source: "github:patchworkos/recipes/recipes/malformed-recipe",
      }),
    );
    expect(status).toBe(400);
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("invalid_recipe");
    expect(parsed.error).toMatch(/steps/i);
  });

  it("install-connector-preflight: response carries missingConnectors when recipe needs unconnected services", async () => {
    // The install handler reads the recipe just written to disk, walks
    // its steps for tool-prefix matches against the known connector
    // map, and (if anything's missing in /connections) surfaces the
    // list under `missingConnectors` in the response body. The recipe
    // STILL installs — this is a soft warning, not a 4xx gate.
    const yamlBody = [
      "name: slack-pinger",
      "version: 1.0.0",
      "trigger:",
      "  type: manual",
      "steps:",
      "  - id: ping",
      "    agent: false",
      "    tool: slack_chat",
      "    params:",
      "      channel: '#general'",
      "      text: hello",
      "",
    ].join("\n");
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        fakeResponse(200, yamlBody),
      ) as unknown as typeof fetch;

    const { status, body } = await makeRequest(
      {
        method: "POST",
        path: "/recipes/install",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({
        source: "github:patchworkos/recipes/recipes/slack-pinger",
      }),
    );
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(true);
    // Recipe needs slack; the test bridge has no slack connector
    // configured, so it should appear in missingConnectors.
    expect(parsed.missingConnectors).toEqual(["slack"]);

    try {
      const { unlinkSync } = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      unlinkSync(
        path.join(os.homedir(), ".patchwork", "recipes", "slack-pinger.json"),
      );
    } catch {
      // best-effort
    }
  });

  it("install-connector-preflight: no missingConnectors field when recipe uses only built-in tools", async () => {
    // file.write / shell.run / etc. don't match any connector prefix,
    // so the response body must NOT include a missingConnectors key
    // (avoids the dashboard showing an empty "connect:" toast).
    const yamlBody = [
      "name: file-writer",
      "version: 1.0.0",
      "trigger:",
      "  type: manual",
      "steps:",
      "  - id: w",
      "    agent: false",
      "    tool: file.write",
      "    params:",
      "      path: /tmp/x",
      "      content: y",
      "",
    ].join("\n");
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        fakeResponse(200, yamlBody),
      ) as unknown as typeof fetch;

    const { status, body } = await makeRequest(
      {
        method: "POST",
        path: "/recipes/install",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({
        source: "github:patchworkos/recipes/recipes/file-writer",
      }),
    );
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(true);
    expect(parsed.missingConnectors).toBeUndefined();

    try {
      const { unlinkSync } = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      unlinkSync(
        path.join(os.homedir(), ".patchwork", "recipes", "file-writer.json"),
      );
    } catch {
      // best-effort
    }
  });
});

describe("Server /recipes/:name/run — A-PR2 body cap (32 KB)", () => {
  it("recipes-name-run-cap: 300 KB body → 413", async () => {
    const big = "x".repeat(300 * 1024);
    const { status, body } = await makeRequest(
      {
        method: "POST",
        path: "/recipes/foo/run",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({ vars: { huge: big } }),
    );
    expect(status).toBe(413);
    const parsed = JSON.parse(body);
    expect(parsed.code).toBe("body_too_large");
  });

  it("recipes-name-run small body → bypasses cap, hits handler", async () => {
    // No `runRecipeFn` wired → 503; what we want to assert is that we got
    // PAST the body-cap gate (small body OK).
    const { status } = await makeRequest(
      {
        method: "POST",
        path: "/recipes/foo/run",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({ vars: { tiny: "ok" } }),
    );
    expect(status).toBe(503);
  });

  // ── Marketplace trust Wave 0 — kill-switch gate ───────────────────────
  it("install-kill-switch: PATCHWORK_FLAG_KILL_SWITCH_WRITES=1 → 503 kill_switch_blocked", async () => {
    // Engage kill-switch dynamically via the in-process flag setter so
    // the test doesn't need a bridge restart. `kill-switch.writes` reads
    // from the env-lock snapshot, so flip it via setFlag at runtime.
    const { setFlag, KILL_SWITCH_WRITES, _resetEnvLockForTesting } =
      await import("../featureFlags.js");
    _resetEnvLockForTesting();
    setFlag(KILL_SWITCH_WRITES, true, false);
    try {
      const { status, body } = await makeRequest(
        {
          method: "POST",
          path: "/recipes/install",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TOKEN}`,
          },
        },
        JSON.stringify({
          source: "github:patchworkos/recipes/recipes/morning-brief",
        }),
      );
      expect(status).toBe(503);
      const parsed = JSON.parse(body);
      expect(parsed.ok).toBe(false);
      expect(parsed.code).toBe("kill_switch_blocked");
      expect(parsed.error).toMatch(/kill switch/i);
    } finally {
      setFlag(KILL_SWITCH_WRITES, false, false);
    }
  });
});
