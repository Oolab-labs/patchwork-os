/**
 * Governed refuses a recipe's own `allowPrivate: true` (Lane D, 2026-10-17).
 *
 * `allowPrivate` is a per-step recipe field that skips the SSRF guard's
 * private-range refusal. Compat honours it unless the operator sets
 * `block-recipe-allow-private`; governed used to honour it too, so a governed
 * recipe could reach loopback and LAN hosts. A recipe must not be able to opt
 * itself out of a workspace guarantee (same rule as `requireApproval: false`).
 *
 * Real loopback server, real http.post: the assertion is on whether the
 * server received the request, not on a mocked fetch.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  FLAG_BLOCK_RECIPE_ALLOW_PRIVATE,
  isEnabled,
  setFlag,
} from "../../../featureFlags.js";
import { governanceReport } from "../../../governance/doctorReport.js";
import {
  computeEffectivePolicy,
  type EffectivePolicyInput,
  formatEffectivePolicy,
  recipePrivateBypassHonoured,
} from "../../../governance/effectivePolicy.js";
import {
  _resetActiveProfileForTesting,
  COMPAT_PROFILE,
  GOVERNED_PROFILE,
  resolveProfile,
  setActiveProfile,
} from "../../../governance/profile.js";
import { executeTool } from "../../toolRegistry.js";
import type { RunContext } from "../../yamlRunner.js";
import "../http.js";

let server: Server;
let url = "";
let received = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    received++;
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
afterEach(() => {
  _resetActiveProfileForTesting();
  setFlag(FLAG_BLOCK_RECIPE_ALLOW_PRIVATE, false);
  received = 0;
});

function post(deps: Record<string, unknown> = {}) {
  const params = { url, body: '{"x":1}', allowPrivate: true, timeoutMs: 2000 };
  return executeTool("http.post", {
    params,
    step: { ...params, tool: "http.post" },
    ctx: { env: {}, steps: {} } as unknown as RunContext,
    // biome-ignore lint/suspicious/noExplicitAny: minimal StepDeps for one tool
    deps: { workdir: process.cwd(), ...deps } as any,
  });
}

describe("http.post allowPrivate under each profile", () => {
  it("compat honours a recipe's allowPrivate (unchanged)", async () => {
    setActiveProfile(COMPAT_PROFILE);
    await expect(post()).resolves.toBeDefined();
    expect(received).toBe(1);
  });

  it("compat with block-recipe-allow-private refuses it (unchanged)", async () => {
    setActiveProfile(COMPAT_PROFILE);
    setFlag(FLAG_BLOCK_RECIPE_ALLOW_PRIVATE, true);
    await expect(post()).rejects.toThrow();
    expect(received).toBe(0);
  });

  it("governed refuses a recipe's allowPrivate: the private host is never reached", async () => {
    setActiveProfile(GOVERNED_PROFILE);
    await expect(post()).rejects.toThrow(
      /not honoured under the governed profile/,
    );
    expect(received).toBe(0);
  });

  it("governed still allows it when the RUN (not the recipe) grants private network access", async () => {
    setActiveProfile(GOVERNED_PROFILE);
    await expect(
      post({ operatorAllowsPrivateNetwork: true }),
    ).resolves.toBeDefined();
    expect(received).toBe(1);
  });

  it("a recipe cannot grant itself the run-level permission through its params", async () => {
    setActiveProfile(GOVERNED_PROFILE);
    const params = {
      url,
      body: "{}",
      allowPrivate: true,
      operatorAllowsPrivateNetwork: true,
      timeoutMs: 2000,
    };
    await expect(
      executeTool("http.post", {
        params,
        step: { ...params, tool: "http.post" },
        ctx: { env: {}, steps: {} } as unknown as RunContext,
        // biome-ignore lint/suspicious/noExplicitAny: minimal StepDeps
        deps: { workdir: process.cwd() } as any,
      }),
    ).rejects.toThrow();
    expect(received).toBe(0);
  });
});

describe("doctor and policy explain report the same answer as http.post", () => {
  const dir = mkdtempSync(join(tmpdir(), "allow-private-doctor-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function row(config: Record<string, unknown>) {
    setActiveProfile(resolveProfile(config));
    const r = governanceReport({
      config: config as unknown as NonNullable<
        Parameters<typeof governanceReport>[0]
      >["config"],
      isFlagOn: isEnabled,
      recipesDir: dir,
      workersDir: dir,
    });
    return r.lines.find((l) => l.key === "privateNetworkBypass");
  }

  it("doctor: governed reports REFUSED and ok", () => {
    const l = row({ profile: "governed" });
    expect(l?.status).toBe("ok");
    expect(l?.value).toMatch(
      /REFUSED \(a recipe's allowPrivate is not honoured\)/,
    );
  });

  it("doctor: compat reports that a recipe may opt in, as a failing line", () => {
    const l = row({ profile: "compat" });
    expect(l?.status).toBe("fail");
    expect(l?.value).toMatch(/RECIPE MAY OPT IN/);
  });

  it("doctor: compat with the operator flag reports REFUSED", () => {
    setFlag(FLAG_BLOCK_RECIPE_ALLOW_PRIVATE, true);
    const l = row({ profile: "compat" });
    expect(l?.status).toBe("ok");
    expect(l?.value).toMatch(/block-recipe-allow-private/);
  });

  it("explain prints the private-network line for http.post, per profile", () => {
    for (const [profile, honoured, want] of [
      [GOVERNED_PROFILE, false, /NOT honoured \(governed\)/],
      [COMPAT_PROFILE, true, /is honoured/],
    ] as const) {
      const input = {
        profile,
        recipe: { name: "r" },
        trigger: "manual",
        tool: {
          id: "http.post",
          tier: "medium",
          tierDeclared: true,
          isWrite: true,
          registered: true,
        },
        killSwitch: { engaged: false, reason: "released" },
        privateNetwork: {
          recipeBypassHonoured: recipePrivateBypassHonoured(profile, false),
        },
      } as unknown as EffectivePolicyInput;
      expect(recipePrivateBypassHonoured(profile, false)).toBe(honoured);
      const text = formatEffectivePolicy(input, computeEffectivePolicy(input));
      expect(text).toMatch(want);
    }
  });
});
