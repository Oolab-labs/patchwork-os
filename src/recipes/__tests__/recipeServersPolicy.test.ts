/**
 * Runtime plugin policy: `loadRecipeServers` re-validates every `servers:`
 * spec against the active profile + `config.plugins.allow` before importing
 * anything. Governed + not allowlisted ⇒ the run halts with
 * `plugin_not_allowlisted`; compat ⇒ existing behaviour.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../pluginLoader.js", () => ({
  loadPluginsFull: vi.fn(),
}));

const allowRef: { allow: Array<{ spec: string; integrity?: string }> } = {
  allow: [],
};
vi.mock("../../patchworkConfig.js", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../patchworkConfig.js")>();
  return {
    ...real,
    loadConfig: () => ({ plugins: { allow: allowRef.allow } }),
  };
});

import {
  _resetActiveProfileForTesting,
  GOVERNED_PROFILE,
  setActiveProfile,
} from "../../governance/profile.js";
import { loadPluginsFull } from "../../pluginLoader.js";
import { clearRegistry } from "../toolRegistry.js";
import { loadRecipeServers } from "../yamlRunner.js";

const mockLoadPluginsFull = vi.mocked(loadPluginsFull);

beforeEach(() => {
  clearRegistry();
  mockLoadPluginsFull.mockReset();
  mockLoadPluginsFull.mockResolvedValue([]);
  allowRef.allow = [];
});
afterEach(() => _resetActiveProfileForTesting());

describe("loadRecipeServers — plugin policy", () => {
  it("governed: a spec outside plugins.allow halts with plugin_not_allowlisted and never imports", async () => {
    setActiveProfile(GOVERNED_PROFILE);
    const p = loadRecipeServers(["./nope-governed"]);
    await expect(p).rejects.toMatchObject({
      code: "plugin_not_allowlisted",
      specs: ["./nope-governed"],
    });
    await expect(p).rejects.toThrow(/"\.\/nope-governed"/);
    expect(mockLoadPluginsFull).not.toHaveBeenCalled();
  });

  it("governed: an allowlisted spec loads, passing its integrity through", async () => {
    setActiveProfile(GOVERNED_PROFILE);
    allowRef.allow = [{ spec: "./ok-governed", integrity: "sha256-AAAA" }];
    await loadRecipeServers(["./ok-governed"]);
    expect(mockLoadPluginsFull).toHaveBeenCalledTimes(1);
    expect(mockLoadPluginsFull.mock.calls[0]?.[0]).toEqual(["./ok-governed"]);
    expect(mockLoadPluginsFull.mock.calls[0]?.[3]).toEqual({
      integrity: "sha256-AAAA",
    });
  });

  it("governed: one refused spec in a list refuses the whole recipe", async () => {
    setActiveProfile(GOVERNED_PROFILE);
    allowRef.allow = [{ spec: "./ok-mixed" }];
    await expect(
      loadRecipeServers(["./ok-mixed", "./bad-mixed"]),
    ).rejects.toMatchObject({ code: "plugin_not_allowlisted" });
    expect(mockLoadPluginsFull).not.toHaveBeenCalled();
  });

  it("compat: the same spec proceeds to the loader (existing behaviour)", async () => {
    // Default active profile is compat.
    await loadRecipeServers(["./nope-compat"]);
    expect(mockLoadPluginsFull).toHaveBeenCalledTimes(1);
    expect(mockLoadPluginsFull.mock.calls[0]?.[3]).toEqual({
      integrity: undefined,
    });
  });

  it("an integrity refusal from the loader halts instead of being logged away", async () => {
    setActiveProfile(GOVERNED_PROFILE);
    allowRef.allow = [{ spec: "./integrity-fail", integrity: "sha256-AAAA" }];
    const { PluginPolicyError } = await import(
      "../../governance/pluginPolicy.js"
    );
    mockLoadPluginsFull.mockRejectedValueOnce(
      new PluginPolicyError("plugin_integrity_mismatch", "bad bytes", [
        "./integrity-fail",
      ]),
    );
    await expect(loadRecipeServers(["./integrity-fail"])).rejects.toMatchObject(
      {
        code: "plugin_integrity_mismatch",
      },
    );
    // Not marked loaded — a later run may retry after the operator fixes it.
    mockLoadPluginsFull.mockResolvedValueOnce([]);
    await loadRecipeServers(["./integrity-fail"]);
    expect(mockLoadPluginsFull).toHaveBeenCalledTimes(2);
  });
});
