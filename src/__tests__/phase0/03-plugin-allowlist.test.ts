/**
 * Phase 0 acceptance — scenario 3: a recipe that names a plugin to load.
 *
 * `servers: ["./not-allowlisted"]` under governed must halt with
 * `plugin_not_allowlisted` BEFORE any step runs. Under compat the loader is
 * invoked (that is today's behaviour, recorded here as the compat gap).
 *
 * `loadRecipeServers` reads the ACTIVE profile and `config.json` under
 * PATCHWORK_HOME; the sandbox home holds no config, so `plugins.allow` is
 * empty.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const loadPluginsFull = vi.fn(
  async (_specs: string[], ..._rest: unknown[]): Promise<never[]> => [],
);
vi.mock("../../pluginLoader.js", () => ({
  loadPluginsFull: (specs: string[], ...rest: unknown[]) =>
    loadPluginsFull(specs, ...rest),
}));

import { PLUGIN_NOT_ALLOWLISTED } from "../../governance/pluginPolicy.js";
import { runYamlRecipe, type YamlRecipe } from "../../recipes/yamlRunner.js";
import {
  baseDeps,
  compatHigh,
  governed,
  makeSandbox,
  recordingApproval,
  registerFakeTool,
  resetGovernanceState,
} from "./_harness.js";

const sandbox = makeSandbox("plugin");
afterAll(() => sandbox.dispose());

function recipe(spec: string): YamlRecipe {
  return {
    name: "plugin-user",
    trigger: { type: "manual" },
    servers: [spec],
    steps: [{ tool: "probe.read", into: "x" }],
  } as unknown as YamlRecipe;
}

describe("scenario 3 — unallowlisted plugin", () => {
  beforeEach(() => {
    resetGovernanceState();
    loadPluginsFull.mockClear();
  });
  afterEach(resetGovernanceState);

  it("governed: halts with plugin_not_allowlisted before any step runs, and the loader is never invoked", async () => {
    const profile = governed();
    const probe = registerFakeTool({
      id: "probe.read",
      isWrite: false,
      execute: async () => "read",
    });
    const approval = recordingApproval(() => true);
    await expect(
      runYamlRecipe(
        recipe("./not-allowlisted"),
        baseDeps(sandbox, {
          governance: profile,
          requireApprovalFn: approval.fn,
        }),
      ),
    ).rejects.toMatchObject({ code: PLUGIN_NOT_ALLOWLISTED });
    expect(loadPluginsFull).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(approval.fn).not.toHaveBeenCalled();
  });

  it("compat: proceeds to the loader with the spec (the documented compat gap)", async () => {
    const profile = compatHigh();
    const probe = registerFakeTool({
      id: "probe.read",
      isWrite: false,
      execute: async () => "read",
    });
    await runYamlRecipe(
      recipe("./not-allowlisted-compat"),
      baseDeps(sandbox, { governance: profile }),
    );
    expect(loadPluginsFull).toHaveBeenCalledTimes(1);
    expect(loadPluginsFull.mock.calls[0]?.[0]).toEqual([
      "./not-allowlisted-compat",
    ]);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
