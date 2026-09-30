/**
 * `patchwork doctor acceptance` — does the INSTALLED package BEHAVE?
 *
 * `patchwork doctor` answers "is the running code the installed code?" by
 * comparing timestamps. That is necessary and not sufficient: deploys were
 * verified by grepping `dist/` for one symbol, and a deploy that silently did
 * not happen (a git ref-lock race) was only noticed later. A string being
 * present in a file is not a behaviour being present in a process.
 *
 * This runs the real runtime entrypoints — the flat runner (`runYamlRecipe`),
 * the policy matrix, the profile-aware kill switch, `http.post`'s uncertain-
 * outcome contract, `replayFlatMockedRun` and `RecipeRunLog.getByTaskId` —
 * in-process, and asserts what they DO.
 *
 * ## Safe on a live production machine, by construction
 *
 * - Every behavioural check runs against a fresh temp `PATCHWORK_HOME` (and a
 *   temp `HOME`, so anything resolving `os.homedir()` lands in the sandbox
 *   too). The operator's config, flags and ledgers are never read or written;
 *   the identity check runs FIRST, before the swap, and reads only lock files
 *   and one mtime.
 * - Network is loopback only: a server this command starts on 127.0.0.1.
 *   No connector, no model call, no git remote.
 * - Approvals are answered by an in-process recorder, never the bridge queue.
 * - Everything is restored and the sandbox removed in `finally`, including
 *   on failure.
 *
 * A separate subcommand from `doctor` for the same reason `doctor health` is:
 * `patchwork doctor && echo deployed` is a real shape, and its exit code must
 * not change meaning.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";

export interface AcceptanceCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface AcceptanceReport {
  ok: boolean;
  total: number;
  passed: number;
  checks: AcceptanceCheck[];
}

export interface AcceptanceOptions {
  /** Lock directory for the identity check (default: the real bridge lock dir). */
  lockDir?: string;
  /** Override the installed build time (tests). */
  buildTimeMs?: number;
  /** Parent directory for the sandbox (default: os.tmpdir()). */
  tmpRoot?: string;
}

const RECIPE_PREFIX = "acceptance-probe";

/** Loopback target counting every request whose body it read to the end. */
interface Target {
  server: Server;
  url: string;
  received: number;
  sockets: Set<Socket>;
}

async function startTarget(): Promise<Target> {
  const t = { received: 0, sockets: new Set<Socket>() } as Target;
  t.server = createServer((req, res) => {
    t.sockets.add(req.socket);
    req.resume();
    req.on("end", () => {
      t.received++;
      if (req.url === "/lost") {
        // Accepted the write, then the response is lost.
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"id":"acc-0001"}');
    });
  });
  await new Promise<void>((resolve) =>
    t.server.listen(0, "127.0.0.1", () => resolve()),
  );
  t.url = `http://127.0.0.1:${(t.server.address() as AddressInfo).port}`;
  return t;
}

async function stopTarget(t: Target | undefined): Promise<void> {
  if (!t) return;
  for (const s of t.sockets) s.destroy();
  await new Promise<void>((resolve) => t.server.close(() => resolve()));
}

async function identityCheck(
  opts: AcceptanceOptions,
): Promise<AcceptanceCheck> {
  const { assessDeploymentFreshness, discoverLocks, installedBuildTimeMs } =
    await import("../deploymentFreshness.js");
  const { PACKAGE_VERSION } = await import("../version.js");
  const buildTimeMs = opts.buildTimeMs ?? installedBuildTimeMs();
  if (buildTimeMs === undefined) {
    return {
      name: "identity",
      ok: false,
      detail: `version ${PACKAGE_VERSION}; no installed build could be located`,
    };
  }
  const report = assessDeploymentFreshness({
    locks: discoverLocks(opts.lockDir),
    buildTimeMs,
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
  });
  const stale = report.findings.filter((f) => f.state === "stale-code").length;
  const live = report.findings.filter(
    (f) => f.state === "fresh" || f.state === "stale-code",
  ).length;
  const detail =
    `version ${PACKAGE_VERSION}; built ${new Date(buildTimeMs).toISOString()}; ` +
    "commit not recorded (the package carries no build commit); " +
    `${live} live bridge(s), ${stale} predating the install`;
  return { name: "identity", ok: !report.unhealthy, detail };
}

export async function runAcceptance(
  opts: AcceptanceOptions = {},
): Promise<AcceptanceReport> {
  const checks: AcceptanceCheck[] = [];
  const record = (name: string, ok: boolean, detail: string) =>
    checks.push({ name, ok, detail });
  const guard = async (name: string, fn: () => Promise<[boolean, string]>) => {
    try {
      const [ok, detail] = await fn();
      record(name, ok, detail);
    } catch (err) {
      record(
        name,
        false,
        `threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // 1. Identity — BEFORE the sandbox swap, since it reads real lock files.
  try {
    checks.push(await identityCheck(opts));
  } catch (err) {
    record("identity", false, `threw: ${String(err)}`);
  }

  const root = mkdtempSync(
    path.join(opts.tmpRoot ?? os.tmpdir(), "patchwork-acceptance-"),
  );
  const home = path.join(root, "patchwork-home");
  const osHome = path.join(root, "os-home");
  const ws = path.join(root, "workspace");
  for (const d of [home, osHome, ws, path.join(home, "config")]) {
    mkdirSync(d, { recursive: true });
  }

  const ENV_KEYS = [
    "PATCHWORK_HOME",
    "HOME",
    "CLAUDE_CONFIG_DIR",
    "PATCHWORK_FLAG_KILL_SWITCH_WRITES",
  ] as const;
  const savedEnv = new Map<string, string | undefined>(
    ENV_KEYS.map((k) => [k, process.env[k]]),
  );
  process.env.PATCHWORK_HOME = home;
  process.env.HOME = osHome;
  process.env.CLAUDE_CONFIG_DIR = path.join(osHome, ".claude");
  delete process.env.PATCHWORK_FLAG_KILL_SWITCH_WRITES;

  const profileMod = await import("../governance/profile.js");
  const flags = await import("../featureFlags.js");
  const prevProfile = profileMod.activeProfile();
  const flagsFile = path.join(home, "config", "flags.json");
  const setKillSwitch = (engaged: boolean) => {
    writeFileSync(
      flagsFile,
      JSON.stringify({ [flags.KILL_SWITCH_WRITES]: engaged }),
    );
    flags.loadFlags();
  };

  let target: Target | undefined;
  try {
    setKillSwitch(false);
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        profile: "governed",
        privacy: {
          destinations: {
            "acceptance-local": {
              type: "local",
              classifications: ["public", "internal"],
              drivers: ["ollama"],
            },
          },
        },
      }),
    );
    const forbiddenDir = path.join(ws, "forbidden");
    writeFileSync(
      path.join(ws, "patchwork.policy.yml"),
      `version: 1\ndefaults:\n  forbiddenPaths:\n    - "${forbiddenDir.replace(/\\/g, "/")}/**"\n`,
    );

    const { loadConfig } = await import("../patchworkConfig.js");
    const config = loadConfig(path.join(home, "config.json"));
    const profile = profileMod.resolveProfile(config);
    profileMod.setActiveProfile(profile);

    const { runYamlRecipe } = await import("../recipes/yamlRunner.js");
    await import("../recipes/tools/http.js");
    const { replayFlatMockedRun } = await import("../recipes/replayRun.js");
    const { RecipeRunLog } = await import("../runLog.js");
    const runLog = new RecipeRunLog({ dir: home });
    target = await startTarget();
    const tgt = target;

    const approvals: string[] = [];
    const approve = async (input: { toolId: string }) => {
      approvals.push(input.toolId);
      return true;
    };
    const deps = () => ({
      workdir: ws,
      logDir: home,
      runLog,
      testMode: false,
      governance: profile,
      requireApprovalFn: approve,
    });
    type Recipe = Parameters<typeof runYamlRecipe>[0];
    const recipe = (name: string, steps: unknown[]): Recipe =>
      ({
        name: `${RECIPE_PREFIX}-${name}`,
        trigger: { type: "manual" },
        steps,
      }) as unknown as Recipe;

    // 2. Effective policy.
    await guard("effective-policy", async () => {
      const { governanceReport } = await import(
        "../governance/doctorReport.js"
      );
      const r = governanceReport({
        config,
        isFlagOn: flags.isEnabled,
        recipesDir: path.join(home, "recipes"),
        workersDir: path.join(home, "workers"),
      });
      return [
        r.governed && profile.mode === "governed",
        r.governed
          ? "temp governed config reports GOVERNED"
          : `NOT GOVERNED: ${r.reasons.join("; ")}`,
      ];
    });

    // 3. Refusal by the policy matrix.
    await guard("policy-refusal", async () => {
      const file = path.join(forbiddenDir, "probe.txt");
      const res = await runYamlRecipe(
        recipe("policy", [{ tool: "file.write", path: file, content: "x" }]),
        deps(),
      );
      const err = res.stepResults[0]?.error ?? "";
      const refused = /policy_denied/.test(err);
      const exists = existsSync(file);
      return [
        refused && !exists,
        `step ${res.stepResults[0]?.status ?? "missing"}${refused ? " (policy_denied)" : ` (${err || "no error"})`}; file ${exists ? "WRITTEN" : "absent"}`,
      ];
    });

    // 4. Kill switch.
    await guard("kill-switch", async () => {
      const file = path.join(ws, "allowed", "ks.txt");
      setKillSwitch(true);
      let res: Awaited<ReturnType<typeof runYamlRecipe>>;
      try {
        res = await runYamlRecipe(
          recipe("killswitch", [
            { tool: "file.write", path: file, content: "x" },
          ]),
          deps(),
        );
      } finally {
        setKillSwitch(false);
      }
      const text = `${res.errorMessage ?? ""} ${res.stepResults.map((s) => s.error ?? "").join(" ")}`;
      const blocked = /kill_switch_blocked|kill switch/i.test(text);
      const exists = existsSync(file);
      return [
        blocked && !exists,
        `${blocked ? "refused (kill_switch_blocked)" : `NOT refused (${text.trim() || "ran"})`}; file ${exists ? "WRITTEN" : "absent"}`,
      ];
    });

    // 5. Uncertain delivery (row 6): accepted, response lost, never resent.
    await guard("uncertain-delivery", async () => {
      tgt.received = 0;
      const res = await runYamlRecipe(
        recipe("uncertain", [
          {
            tool: "http.post",
            url: `${tgt.url}/lost`,
            body: '{"probe":1}',
            allowPrivate: true,
            timeoutMs: 2000,
            retry: 2,
            retryDelay: 1,
          },
        ]),
        deps(),
      );
      const step = res.stepResults[0];
      const uncertain = /outcome_uncertain/.test(step?.error ?? "");
      return [
        step?.status === "error" && uncertain && tgt.received === 1,
        `step ${step?.status ?? "missing"}${uncertain ? " (outcome_uncertain)" : ""}; server received ${tgt.received} request(s), expected 1`,
      ];
    });

    // 6 + 7. Replay by taskId, and the lookup the HTTP route uses.
    let originalTaskId: string | undefined;
    await guard("run-lookup", async () => {
      tgt.received = 0;
      approvals.length = 0;
      const name = "replay";
      const res = await runYamlRecipe(
        recipe(name, [
          {
            tool: "http.post",
            url: `${tgt.url}/ok`,
            body: '{"probe":2}',
            into: "posted",
            allowPrivate: true,
            timeoutMs: 2000,
          },
        ]),
        deps(),
      );
      if (res.stepResults[0]?.status !== "ok" || tgt.received !== 1) {
        return [
          false,
          `original run did not complete (step ${res.stepResults[0]?.status}: ${res.stepResults[0]?.error ?? ""})`,
        ];
      }
      const listed = runLog.query({ recipe: `${RECIPE_PREFIX}-${name}` });
      originalTaskId = listed[0]?.taskId;
      const found = originalTaskId ? runLog.getByTaskId(originalTaskId) : null;
      return [
        found !== null && found.taskId === originalTaskId,
        found ? "original run resolves by taskId" : "run NOT found by taskId",
      ];
    });

    await guard("replay", async () => {
      if (!originalTaskId) return [false, "no original run to replay"];
      const original = runLog.getByTaskId(originalTaskId);
      if (!original) return [false, "original run not found by taskId"];
      const before = tgt.received;
      approvals.length = 0;
      const r = await replayFlatMockedRun({
        originalRun: original,
        recipe: recipe("replay", [
          {
            tool: "http.post",
            url: `${tgt.url}/ok`,
            body: '{"probe":2}',
            into: "posted",
            allowPrivate: true,
            timeoutMs: 2000,
          },
        ]) as unknown as Parameters<typeof replayFlatMockedRun>[0]["recipe"],
        deps: {
          runLog,
          runnerDeps: {
            workdir: ws,
            logDir: home,
            governance: profile,
            requireApprovalFn: approve,
          },
        },
      });
      const newRequests = tgt.received - before;
      const rows = runLog.query({ recipe: `${RECIPE_PREFIX}-replay` });
      const replayRow = rows.find(
        (row) =>
          row.taskId !== originalTaskId &&
          (row as { replay?: true }).replay === true,
      );
      return [
        r.ok && newRequests === 0 && approvals.length === 0 && !!replayRow,
        `replay ${r.ok ? "ok" : `failed (${r.error ?? "?"})`}; ${newRequests} new request(s); ${approvals.length} approval(s) requested; replay row ${replayRow ? "stamped replay: true" : "MISSING"}`,
      ];
    });
  } finally {
    await stopTarget(target).catch(() => {});
    try {
      setKillSwitch(false);
    } catch {
      // sandbox may already be unusable; env restore below still runs
    }
    profileMod.setActiveProfile(prevProfile);
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }

  // Order the report as documented: identity, policy, refusal, kill switch,
  // uncertain, replay, lookup.
  const order = [
    "identity",
    "effective-policy",
    "policy-refusal",
    "kill-switch",
    "uncertain-delivery",
    "replay",
    "run-lookup",
  ];
  checks.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  const passed = checks.filter((c) => c.ok).length;
  return {
    ok: passed === checks.length && checks.length === order.length,
    total: checks.length,
    passed,
    checks,
  };
}

export function formatAcceptance(r: AcceptanceReport): string {
  const out = [`${r.total} checks`];
  for (const c of r.checks) {
    out.push(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(20)}${c.detail}`);
  }
  out.push(
    r.ok
      ? `ACCEPTED: ${r.passed}/${r.total} passed`
      : `NOT ACCEPTED: ${r.total - r.passed} of ${r.total} failed`,
  );
  return out.join("\n");
}
