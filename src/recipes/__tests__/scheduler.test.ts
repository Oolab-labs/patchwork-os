import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSchedule, RecipeScheduler } from "../scheduler.js";

describe("parseSchedule", () => {
  it.each([
    ["@every 30s", 30_000],
    ["@every 5m", 5 * 60_000],
    ["@every 2h", 2 * 60 * 60_000],
    ["@every 250ms", 250],
    ["  @every 1m  ", 60_000],
  ])("parses %s → %d ms", (input, expected) => {
    const result = parseSchedule(input);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("interval");
    expect(
      (result as { kind: "interval"; intervalMs: number }).intervalMs,
    ).toBe(expected);
  });

  it.each([
    ["0 8 * * 1-5"],
    ["*/5 * * * *"],
    ["0 0 * * *"],
  ])("parses cron5 expression %s", (input) => {
    const result = parseSchedule(input);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("cron5");
    expect((result as { kind: "cron5"; expression: string }).expression).toBe(
      input.trim(),
    );
  });

  it.each([
    "",
    "@every 0s",
    "@every -1m",
    "every 5m",
    "@every 5",
    "@every 5d",
  ])("rejects unsupported schedule %s", (input) => {
    expect(parseSchedule(input)).toBeNull();
  });
});

describe("RecipeScheduler", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "patchwork-sched-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeRecipe(
    name: string,
    trigger: { type: string; schedule?: string },
    opts: { prompt?: string } = {},
  ) {
    const body = {
      name,
      version: "1",
      description: `Test recipe ${name}`,
      trigger,
      steps: [
        {
          id: "main",
          agent: true,
          prompt: opts.prompt ?? `run ${name}`,
        },
      ],
    };
    writeFileSync(
      path.join(tmp, `${name}.json`),
      JSON.stringify(body, null, 2),
    );
  }

  it("schedules only cron-triggered recipes", () => {
    writeRecipe("every-minute", { type: "cron", schedule: "@every 1m" });
    writeRecipe("manual-only", { type: "manual" });
    const enqueued: string[] = [];
    const scheduler = new RecipeScheduler({
      recipesDir: tmp,
      enqueue: ({ triggerSource }) => {
        enqueued.push(triggerSource);
        return "tid";
      },
    });
    const scheduled = scheduler.start();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.name).toBe("every-minute");
    expect(scheduled[0]!.intervalMs).toBe(60_000);
    scheduler.stop();
  });

  it("fires enqueue on each interval tick (fake timers)", () => {
    writeRecipe("every-second", { type: "cron", schedule: "@every 1s" });
    const enqueued: Array<{ prompt: string; triggerSource: string }> = [];
    const fakeTimer: { cb: () => void; ms: number } = { cb: () => {}, ms: 0 };
    const scheduler = new RecipeScheduler({
      recipesDir: tmp,
      enqueue: (opts) => {
        enqueued.push({
          prompt: opts.prompt,
          triggerSource: opts.triggerSource,
        });
        return "tid";
      },
      setInterval: ((cb: () => void, ms: number) => {
        fakeTimer.cb = cb;
        fakeTimer.ms = ms;
        return { ref: () => {}, unref: () => {} } as unknown as NodeJS.Timeout;
      }) as unknown as typeof setInterval,
      clearInterval: (() => {}) as unknown as typeof clearInterval,
    });
    scheduler.start();
    expect(fakeTimer.ms).toBe(1000);
    expect(enqueued).toHaveLength(0);

    fakeTimer.cb();
    fakeTimer.cb();
    expect(enqueued).toHaveLength(2);
    expect(enqueued[0]!.triggerSource).toBe("cron:every-second");
    expect(enqueued[0]!.prompt).toContain("every-second");
    expect(enqueued[0]!.prompt).toContain("RECIPE DONE");
  });

  it("skips cron recipes with an unsupported schedule string", () => {
    writeRecipe("bad", { type: "cron", schedule: "not-a-schedule" });
    writeRecipe("good", { type: "cron", schedule: "@every 10m" });
    const scheduler = new RecipeScheduler({
      recipesDir: tmp,
      enqueue: () => "tid",
    });
    const scheduled = scheduler.start();
    expect(scheduled.map((s) => s.name).sort()).toEqual(["good"]);
  });

  it("stop() clears all timers and list() returns empty", () => {
    writeRecipe("a", { type: "cron", schedule: "@every 1m" });
    writeRecipe("b", { type: "cron", schedule: "@every 2m" });
    let cleared = 0;
    const scheduler = new RecipeScheduler({
      recipesDir: tmp,
      enqueue: () => "tid",
      setInterval: (() =>
        ({}) as unknown as NodeJS.Timeout) as unknown as typeof setInterval,
      clearInterval: (() => {
        cleared++;
      }) as unknown as typeof clearInterval,
    });
    expect(scheduler.start()).toHaveLength(2);
    scheduler.stop();
    expect(cleared).toBe(2);
    expect(scheduler.list()).toHaveLength(0);
  });

  it("tolerates missing recipes directory", () => {
    const scheduler = new RecipeScheduler({
      recipesDir: path.join(tmp, "does-not-exist"),
      enqueue: () => "tid",
    });
    expect(scheduler.start()).toEqual([]);
  });

  it("ignores malformed recipe files", () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(path.join(tmp, "broken.json"), "{ not json");
    writeRecipe("ok", { type: "cron", schedule: "@every 30s" });
    const scheduler = new RecipeScheduler({
      recipesDir: tmp,
      enqueue: () => "tid",
    });
    const scheduled = scheduler.start();
    expect(scheduled.map((s) => s.name)).toEqual(["ok"]);
  });

  it("fires YAML recipes by declared name when filename differs", () => {
    writeFileSync(
      path.join(tmp, "custom-name.yaml"),
      [
        "name: scheduled-yaml",
        "trigger:",
        "  type: cron",
        "  at: '@every 1m'",
        "steps:",
        "  - tool: file.write",
        "    path: /tmp/out.txt",
        "    content: ok",
        "",
      ].join("\n"),
    );
    const ran: string[] = [];
    const scheduler = new RecipeScheduler({
      recipesDir: tmp,
      enqueue: () => "tid",
      runYaml: async (name) => {
        ran.push(name);
      },
    });

    const scheduled = scheduler.start();
    expect(scheduled.map((s) => s.name)).toEqual(["scheduled-yaml"]);
    scheduler.fireForTest("scheduled-yaml");
    expect(ran).toEqual(["scheduled-yaml"]);
  });

  // ─── install-dir recipes (recipeInstall) + `.disabled` marker ────────────
  // PR #42 added the marker file but only `recipe enable/disable` checked it.
  // The scheduler now also honors it for recipes installed into subdirs.

  function installDirRecipe(
    dirName: string,
    yaml: string,
    opts: { disabled?: boolean; manifestMain?: string } = {},
  ) {
    const dir = path.join(tmp, dirName);
    mkdirSync(dir, { recursive: true });
    const yamlFile = opts.manifestMain ?? "main.yaml";
    writeFileSync(path.join(dir, yamlFile), yaml);
    if (opts.manifestMain) {
      writeFileSync(
        path.join(dir, "recipe.json"),
        JSON.stringify(
          { name: dirName, version: "1", recipes: { main: opts.manifestMain } },
          null,
          2,
        ),
      );
    }
    if (opts.disabled) {
      writeFileSync(path.join(dir, ".disabled"), "");
    }
    return dir;
  }

  it("schedules a cron-triggered recipe installed into a subdirectory", () => {
    installDirRecipe(
      "morning-brief",
      [
        "name: morning-brief",
        "trigger:",
        "  type: cron",
        "  at: '@every 5m'",
        "steps:",
        "  - id: main",
        "    agent: true",
        "    prompt: brief me",
      ].join("\n"),
    );

    const scheduler = new RecipeScheduler({
      recipesDir: tmp,
      enqueue: () => "tid",
      runYaml: async () => {},
    });

    const scheduled = scheduler.start();
    expect(scheduled.map((s) => s.name).sort()).toContain("morning-brief");
    scheduler.stop();
  });

  it("skips a recipe whose install dir contains a .disabled marker", () => {
    installDirRecipe(
      "standup-digest",
      [
        "name: standup-digest",
        "trigger:",
        "  type: cron",
        "  at: '@every 1h'",
        "steps:",
        "  - id: main",
        "    agent: true",
        "    prompt: digest",
      ].join("\n"),
      { disabled: true },
    );

    const scheduler = new RecipeScheduler({
      recipesDir: tmp,
      enqueue: () => "tid",
      runYaml: async () => {},
    });

    const scheduled = scheduler.start();
    expect(scheduled.map((s) => s.name)).not.toContain("standup-digest");
  });

  it("uses recipe.json manifest's `recipes.main` when present", () => {
    installDirRecipe(
      "weekly-roundup",
      [
        "name: weekly-roundup",
        "trigger:",
        "  type: cron",
        "  at: '@every 7h'",
        "steps:",
        "  - id: main",
        "    agent: true",
        "    prompt: roll up",
      ].join("\n"),
      { manifestMain: "recipe.yaml" },
    );

    const scheduler = new RecipeScheduler({
      recipesDir: tmp,
      enqueue: () => "tid",
      runYaml: async () => {},
    });

    const scheduled = scheduler.start();
    expect(scheduled.map((s) => s.name)).toContain("weekly-roundup");
  });

  it("does not schedule a manual-trigger recipe in an install dir", () => {
    installDirRecipe(
      "manual-only",
      [
        "name: manual-only",
        "trigger:",
        "  type: manual",
        "steps:",
        "  - id: main",
        "    agent: true",
        "    prompt: hi",
      ].join("\n"),
    );

    const scheduler = new RecipeScheduler({
      recipesDir: tmp,
      enqueue: () => "tid",
      runYaml: async () => {},
    });

    const scheduled = scheduler.start();
    expect(scheduled.map((s) => s.name)).not.toContain("manual-only");
  });
});
