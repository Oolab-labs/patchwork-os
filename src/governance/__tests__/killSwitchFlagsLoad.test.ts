import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_PATCHWORK_HOME = process.env.PATCHWORK_HOME;
const KILL_SWITCH_ENV = "PATCHWORK_FLAG_KILL_SWITCH_WRITES";
const homes: string[] = [];

function syntheticHome(flagsContents?: string): string {
  const home = mkdtempSync(join(tmpdir(), "pw-gate3a-flags-"));
  homes.push(home);
  if (flagsContents !== undefined) {
    const configDir = join(home, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "flags.json"), flagsContents, "utf8");
  }
  return home;
}

async function importRuntimeAt(home: string, killSwitchEnv?: string) {
  process.env.PATCHWORK_HOME = home;
  if (killSwitchEnv === undefined) {
    delete process.env[KILL_SWITCH_ENV];
  } else {
    process.env[KILL_SWITCH_ENV] = killSwitchEnv;
  }
  vi.resetModules();
  const featureFlags = await import("../../featureFlags.js");
  const killSwitchPolicy = await import("../killSwitchPolicy.js");
  const profile = await import("../profile.js");
  return { featureFlags, killSwitchPolicy, profile };
}

afterEach(() => {
  vi.resetModules();
  delete process.env[KILL_SWITCH_ENV];
  if (ORIGINAL_PATCHWORK_HOME === undefined) {
    delete process.env.PATCHWORK_HOME;
  } else {
    process.env.PATCHWORK_HOME = ORIGINAL_PATCHWORK_HOME;
  }
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("Gate 3A — production flags loader reaches kill-switch policy", () => {
  it("treats a fresh missing file and valid sparse object as released", async () => {
    const missing = await importRuntimeAt(syntheticHome());
    expect(
      missing.killSwitchPolicy.readKillSwitch(missing.profile.GOVERNED_PROFILE),
    ).toEqual({ engaged: false, reason: "released" });

    const sparse = await importRuntimeAt(syntheticHome("{}"));
    expect(
      sparse.killSwitchPolicy.readKillSwitch(sparse.profile.GOVERNED_PROFILE),
    ).toEqual({ engaged: false, reason: "released" });
  });

  it.each([
    [true, "engaged"],
    [false, "released"],
  ] as const)("loads an explicit boolean kill-switch value %s", async (value, reason) => {
    const runtime = await importRuntimeAt(
      syntheticHome(JSON.stringify({ "kill-switch.writes": value })),
    );
    expect(
      runtime.killSwitchPolicy.readKillSwitch(runtime.profile.GOVERNED_PROFILE),
    ).toEqual({ engaged: value, reason });
  });

  it("fails closed under governed when the real startup file contains malformed JSON", async () => {
    const runtime = await importRuntimeAt(syntheticHome("{not-json"));

    expect(
      runtime.killSwitchPolicy.readKillSwitch(runtime.profile.GOVERNED_PROFILE),
    ).toEqual({
      engaged: true,
      reason: "unreadable_fail_closed",
    });
  });

  it("preserves compat fail-open for a previously released malformed startup state", async () => {
    const runtime = await importRuntimeAt(syntheticHome("{not-json"));

    expect(
      runtime.killSwitchPolicy.readKillSwitch(runtime.profile.COMPAT_PROFILE),
    ).toEqual({ engaged: false, reason: "unreadable_fail_open" });
  });

  it.each([
    "null",
    "[]",
    '"flags"',
  ])("rejects invalid top-level JSON shape %s", async (contents) => {
    const runtime = await importRuntimeAt(syntheticHome(contents));
    expect(
      runtime.killSwitchPolicy.readKillSwitch(runtime.profile.GOVERNED_PROFILE),
    ).toEqual({ engaged: true, reason: "unreadable_fail_closed" });
  });

  it.each([
    '"true"',
    "1",
    "null",
    "{}",
  ])("rejects non-boolean present kill-switch value %s", async (value) => {
    const runtime = await importRuntimeAt(
      syntheticHome(`{"kill-switch.writes":${value}}`),
    );
    expect(
      runtime.killSwitchPolicy.readKillSwitch(runtime.profile.GOVERNED_PROFILE),
    ).toEqual({ engaged: true, reason: "unreadable_fail_closed" });
  });

  it("surfaces a deterministic filesystem read failure", async () => {
    const home = syntheticHome();
    mkdirSync(join(home, "config"), { recursive: true });
    mkdirSync(join(home, "config", "flags.json"));

    const runtime = await importRuntimeAt(home);
    expect(
      runtime.killSwitchPolicy.readKillSwitch(runtime.profile.GOVERNED_PROFILE),
    ).toEqual({ engaged: true, reason: "unreadable_fail_closed" });
  });

  it("propagates watcher reload failure and recovers after a valid reload", async () => {
    const home = syntheticHome('{"kill-switch.writes":false}');
    const runtime = await importRuntimeAt(home);
    let notify: (() => void) | undefined;
    const stop = runtime.featureFlags.watchFlags({
      debounceMs: 0,
      watcherFn: (_dir, onChange) => {
        notify = onChange;
        return () => {};
      },
    });

    writeFileSync(join(home, "config", "flags.json"), "{bad", "utf8");
    notify?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      runtime.killSwitchPolicy.readKillSwitch(runtime.profile.GOVERNED_PROFILE),
    ).toEqual({ engaged: true, reason: "unreadable_fail_closed" });

    writeFileSync(
      join(home, "config", "flags.json"),
      '{"kill-switch.writes":true}',
      "utf8",
    );
    notify?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      runtime.killSwitchPolicy.readKillSwitch(runtime.profile.GOVERNED_PROFILE),
    ).toEqual({ engaged: true, reason: "engaged" });
    stop();
  });

  it("does not release an already-engaged cache when a reload becomes unreadable", async () => {
    const home = syntheticHome('{"kill-switch.writes":true}');
    const runtime = await importRuntimeAt(home);
    writeFileSync(join(home, "config", "flags.json"), "{bad", "utf8");
    runtime.featureFlags.loadFlags();

    expect(
      runtime.killSwitchPolicy.readKillSwitch(runtime.profile.GOVERNED_PROFILE),
    ).toEqual({ engaged: true, reason: "unreadable_engaged" });
    expect(
      runtime.killSwitchPolicy.readKillSwitch(runtime.profile.COMPAT_PROFILE),
    ).toEqual({ engaged: true, reason: "unreadable_engaged" });
  });

  it.each([
    ["an empty object", "{}"],
    ["only an unrelated flag", '{"ui.schema-lint":true}'],
  ])("retains cached engagement when a sparse reload contains %s", async (_label, contents) => {
    const home = syntheticHome('{"kill-switch.writes":true}');
    const runtime = await importRuntimeAt(home);
    writeFileSync(join(home, "config", "flags.json"), contents, "utf8");
    runtime.featureFlags.loadFlags();

    expect(
      runtime.killSwitchPolicy.readKillSwitch(runtime.profile.GOVERNED_PROFILE),
    ).toEqual({ engaged: true, reason: "engaged" });
    expect(
      runtime.killSwitchPolicy.readKillSwitch(runtime.profile.COMPAT_PROFILE),
    ).toEqual({ engaged: true, reason: "engaged" });
  });

  it("releases cached engagement when a reload explicitly supplies false", async () => {
    const home = syntheticHome('{"kill-switch.writes":true}');
    const runtime = await importRuntimeAt(home);
    writeFileSync(
      join(home, "config", "flags.json"),
      '{"kill-switch.writes":false}',
      "utf8",
    );
    runtime.featureFlags.loadFlags();

    expect(
      runtime.killSwitchPolicy.readKillSwitch(runtime.profile.GOVERNED_PROFILE),
    ).toEqual({ engaged: false, reason: "released" });
    expect(
      runtime.killSwitchPolicy.readKillSwitch(runtime.profile.COMPAT_PROFILE),
    ).toEqual({ engaged: false, reason: "released" });
  });

  it.each([
    ["true", true, "engaged", "false"],
    ["false", false, "released", "true"],
  ] as const)("keeps frozen env=%s authoritative over an unreadable file and post-lock mutation", async (initialEnv, engaged, reason, mutation) => {
    const runtime = await importRuntimeAt(syntheticHome("{bad"), initialEnv);
    runtime.featureFlags.lockKillSwitchEnv();
    process.env[KILL_SWITCH_ENV] = mutation;

    expect(
      runtime.killSwitchPolicy.readKillSwitch(runtime.profile.GOVERNED_PROFILE),
    ).toEqual({ engaged, reason });
  });

  it.each([
    true,
    false,
  ])("retains and labels cached=%s when a previously loaded file disappears", async (cachedEngaged) => {
    const home = syntheticHome(
      JSON.stringify({ "kill-switch.writes": cachedEngaged }),
    );
    const runtime = await importRuntimeAt(home);
    rmSync(join(home, "config", "flags.json"));
    runtime.featureFlags.loadFlags();

    expect(
      runtime.killSwitchPolicy.readKillSwitch(runtime.profile.GOVERNED_PROFILE),
    ).toEqual({
      engaged: cachedEngaged,
      reason: "missing_after_load_cached",
    });

    const { governanceReport } = await import("../doctorReport.js");
    const report = governanceReport({
      config: { profile: "governed" } as never,
      recipesDir: join(home, "recipes"),
      workersDir: join(home, "workers"),
    });
    expect(
      report.lines.find((line) => line.key === "killSwitch"),
    ).toMatchObject({
      value: `STALE (flags file missing; cached ${cachedEngaged ? "engaged" : "released"})`,
      status: "warn",
    });
  });

  it("blocks a production-shaped governed write dispatch without invoking its effect", async () => {
    const runtime = await importRuntimeAt(syntheticHome("{bad"));
    runtime.profile.setActiveProfile(runtime.profile.GOVERNED_PROFILE);
    const registry = await import("../../recipes/toolRegistry.js");
    const effect = vi.fn(async () => "written");
    registry.registerTool({
      id: "synthetic.write",
      namespace: "synthetic",
      description: "synthetic governed write",
      paramsSchema: {},
      outputSchema: {},
      riskDefault: "high",
      isWrite: true,
      execute: effect,
    });

    await expect(
      registry.executeTool("synthetic.write", {
        params: {},
        step: {},
        ctx: {},
        deps: {},
      } as never),
    ).rejects.toMatchObject({ code: "kill_switch_blocked" });
    expect(effect).not.toHaveBeenCalled();
    registry.clearRegistry();
  });
});
