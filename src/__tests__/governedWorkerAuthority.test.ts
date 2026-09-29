/**
 * `profile: governed` must turn the worker trust-ramp gate ON at runtime — not
 * only in what `patchwork doctor` and `patchwork policy explain` report.
 *
 * The defect: the profile carried `workerAuthority: true`, doctor and explain
 * read it and said ENFORCED, but the two runtime builders
 * (`buildWorkerAutonomyGate`, `buildWorkerAgentDisallowedTools`) consulted only
 * `FLAG_WORKER_AUTONOMY`. The bridge papered over it by flipping the flag in
 * memory at startup, which any of three things undid silently: an operator's
 * `PATCHWORK_FLAG_WORKER_AUTONOMY=0`, a `flags.json` reload carrying
 * `"worker.autonomy": false`, or a process that publishes the profile without
 * also flipping the flag. In each case doctor said ENFORCED while worker
 * recipes ran ungated.
 *
 * These tests go through the production seams: the profile is published with
 * `setActiveProfile(resolveProfile(...))` exactly as `bridge.ts` does, and the
 * flag is left at its registered default rather than hand-set to true.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FLAG_WORKER_AUTONOMY, isEnabled, setFlag } from "../featureFlags.js";
import { governanceReport } from "../governance/doctorReport.js";
import {
  _resetActiveProfileForTesting,
  resolveProfile,
  setActiveProfile,
} from "../governance/profile.js";
import type { loadConfig } from "../patchworkConfig.js";
import {
  buildWorkerAgentDisallowedTools,
  buildWorkerAutonomyGate,
} from "../recipeOrchestration.js";

const ENV_KEY = "PATCHWORK_FLAG_WORKER_AUTONOMY";

const WORKER_YAML = `id: example-worker
name: Example Worker
recipe: example-recipe
owns:
  - fs-write
  - vcs-remote
autonomyCeiling: 4
`;

describe("governed profile drives the worker gate at runtime", () => {
  let dir: string;
  let opts: { workersDir: string; patchworkDir: string };
  let savedEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "pw-gov-wauth-"));
    const workersDir = path.join(dir, "workers");
    mkdirSync(workersDir, { recursive: true });
    writeFileSync(path.join(workersDir, "example.worker.yaml"), WORKER_YAML);
    opts = { workersDir, patchworkDir: dir };
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    // The registered default — NOT a hand-injected value.
    setFlag(FLAG_WORKER_AUTONOMY, false, false);
    _resetActiveProfileForTesting();
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
    setFlag(FLAG_WORKER_AUTONOMY, false, false);
    _resetActiveProfileForTesting();
    rmSync(dir, { recursive: true, force: true });
  });

  it("governed + flag unset → the worker gate fn is built", async () => {
    setActiveProfile(resolveProfile({ profile: "governed" }));
    expect(isEnabled(FLAG_WORKER_AUTONOMY)).toBe(false);
    const g = await buildWorkerAutonomyGate("example-recipe", undefined, opts);
    expect(g).not.toBeNull();
  });

  it("governed + flag unset → agent steps get the worker's disallowed-tools list", async () => {
    setActiveProfile(resolveProfile({ profile: "governed" }));
    const list = await buildWorkerAgentDisallowedTools("example-recipe", opts);
    expect(list).not.toBeNull();
    expect(list?.length).toBeGreaterThan(0);
  });

  it("governed + env explicitly 0 → still built (the profile turns it ON)", async () => {
    setActiveProfile(resolveProfile({ profile: "governed" }));
    process.env[ENV_KEY] = "0";
    expect(isEnabled(FLAG_WORKER_AUTONOMY)).toBe(false);
    const g = await buildWorkerAutonomyGate("example-recipe", undefined, opts);
    expect(g).not.toBeNull();
  });

  it("governed + non-worker recipe → still null (no worker owns it)", async () => {
    setActiveProfile(resolveProfile({ profile: "governed" }));
    const g = await buildWorkerAutonomyGate("unowned-recipe", undefined, opts);
    expect(g).toBeNull();
    const list = await buildWorkerAgentDisallowedTools("unowned-recipe", opts);
    expect(list).toBeNull();
  });

  it("control: compat + flag unset → null (byte-identical to before)", async () => {
    setActiveProfile(resolveProfile({ profile: "compat" }));
    expect(
      await buildWorkerAutonomyGate("example-recipe", undefined, opts),
    ).toBeNull();
    expect(
      await buildWorkerAgentDisallowedTools("example-recipe", opts),
    ).toBeNull();
  });

  it("control: no profile key + flag unset → null", async () => {
    setActiveProfile(resolveProfile(undefined));
    expect(
      await buildWorkerAutonomyGate("example-recipe", undefined, opts),
    ).toBeNull();
  });

  it("control: compat + flag set via env → built", async () => {
    setActiveProfile(resolveProfile({ profile: "compat" }));
    process.env[ENV_KEY] = "1";
    expect(
      await buildWorkerAutonomyGate("example-recipe", undefined, opts),
    ).not.toBeNull();
  });
});

describe("doctor reports exactly what the runtime enforces", () => {
  let dir: string;
  let opts: { workersDir: string; patchworkDir: string };
  let savedEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "pw-gov-wauth-doc-"));
    const workersDir = path.join(dir, "workers");
    mkdirSync(workersDir, { recursive: true });
    mkdirSync(path.join(dir, "recipes"), { recursive: true });
    writeFileSync(path.join(workersDir, "example.worker.yaml"), WORKER_YAML);
    opts = { workersDir, patchworkDir: dir };
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    setFlag(FLAG_WORKER_AUTONOMY, false, false);
    _resetActiveProfileForTesting();
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
    setFlag(FLAG_WORKER_AUTONOMY, false, false);
    _resetActiveProfileForTesting();
    rmSync(dir, { recursive: true, force: true });
  });

  const cases: Array<{ profile: string | undefined; flag: boolean }> = [
    { profile: "governed", flag: false },
    { profile: "governed", flag: true },
    { profile: "compat", flag: false },
    { profile: "compat", flag: true },
    { profile: undefined, flag: false },
  ];

  for (const c of cases) {
    for (const live of [false, true]) {
      it(`profile=${c.profile ?? "(absent)"} flag=${c.flag} live=${live}`, async () => {
        const config = (c.profile ? { profile: c.profile } : {}) as ReturnType<
          typeof loadConfig
        >;
        setActiveProfile(resolveProfile(config));
        if (c.flag) process.env[ENV_KEY] = "1";
        const runtimeOn =
          (await buildWorkerAutonomyGate("example-recipe", undefined, opts)) !==
          null;
        const report = governanceReport({
          config,
          isFlagOn: isEnabled,
          recipesDir: path.join(dir, "recipes"),
          workersDir: opts.workersDir,
          live,
        });
        const line = report.lines.find((l) => l.key === "workerAuthority");
        expect(line).toBeDefined();
        expect(line?.value === "ENFORCED").toBe(runtimeOn);
      });
    }
  }
});
