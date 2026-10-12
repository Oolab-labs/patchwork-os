/**
 * Which version of a recipe did a run execute?
 *
 * The run-plan routes rebuild a plan from the recipe file on disk NOW, keyed
 * only by the run's recipe name. Nothing recorded which bytes the run actually
 * executed, so a run page could not say whether the recipe had changed since.
 *
 * These tests pin the three halves of the fix:
 *   1. each runner stamps `recipeSha256` — the sha256 of the exact bytes it
 *      loaded — on the run row, and every store keeps it on read;
 *   2. the dry-run plan says which bytes it was built from;
 *   3. the run-plan routes compare the two, answering "unknown" (never a
 *      guess) for a run that predates the field.
 */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRecipeDryPlan } from "../../commands/recipe.js";
import type { RecipeRouteDeps } from "../../recipeRoutes.js";
import { tryHandleRecipeRoute } from "../../recipeRoutes.js";
import { type RecipeRun, RecipeRunLog } from "../../runLog.js";
import { SqliteRunRepository } from "../../runStore/sqliteRunRepository.js";
import type { ChainedRecipe, ExecutionDeps } from "../chainedRunner.js";
import { runChainedRecipe } from "../chainedRunner.js";
import type { RunnerDeps } from "../yamlRunner.js";
import { loadYamlRecipe, runYamlRecipe } from "../yamlRunner.js";

const sha = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");

let dir: string;
const opened: SqliteRunRepository[] = [];
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "recipe-version-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const r of opened.splice(0)) r.close();
  rmSync(dir, { recursive: true, force: true });
});

function readRows(logDir: string): Array<Record<string, unknown>> {
  const file = path.join(logDir, "runs.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// A trailing comment and CRLF-free odd spacing: bytes that a re-serialisation
// of the parsed recipe would NOT reproduce, so a hash of anything other than
// the file's exact bytes fails these tests.
const FLAT_YAML = `name: noisy-recipe
trigger:
  type: manual
steps:
  - tool: diagnostics
    uri: file:///nope.ts
    into: diag
# trailing comment that parsing discards
`;

const CHAINED_YAML = `name: noisy-chained
trigger:
  type: chained
steps:
  - id: s1
    tool: noop.tool
# trailing comment that parsing discards
`;

function flatDeps(extra: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    now: () => new Date("2026-04-18T08:00:00Z"),
    logDir: dir,
    testMode: false,
    readFile: () => {
      throw new Error("not found");
    },
    writeFile: () => {},
    appendFile: () => {},
    mkdir: () => {},
    gitLogSince: () => "",
    gitStaleBranches: () => "",
    getDiagnostics: () => "",
    ...extra,
  };
}

const chainedDeps: ExecutionDeps = {
  executeTool: vi.fn().mockResolvedValue("ok"),
  executeAgent: vi.fn().mockResolvedValue("agent"),
  loadNestedRecipe: vi.fn().mockResolvedValue(null),
};

function writeRecipe(name: string, text: string): string {
  const p = path.join(dir, name);
  writeFileSync(p, text);
  return p;
}

describe("1. a run records the hash of the bytes it ran", () => {
  it("flat runner, bridge path (startRun → completeRun)", async () => {
    const file = writeRecipe("noisy-recipe.yaml", FLAT_YAML);
    const expected = sha(readFileSync(file));
    const recipe = loadYamlRecipe(file);
    // Edit the file AFTER load: the run must record what it executed, not
    // a re-read of whatever is on disk later.
    writeFileSync(file, `${FLAT_YAML}# edited after load\n`);
    const runLog = new RecipeRunLog({ dir });
    await runYamlRecipe(recipe, flatDeps({ runLog }));
    const rows = readRows(dir);
    expect(rows.length).toBeGreaterThanOrEqual(2); // running + terminal
    for (const r of rows) expect(r.recipeSha256).toBe(expected);
    expect(runLog.query({ limit: 5 })[0]?.recipeSha256).toBe(expected);
  });

  it("flat runner, CLI path (appendDirect)", async () => {
    const file = writeRecipe("noisy-recipe.yaml", FLAT_YAML);
    const recipe = loadYamlRecipe(file);
    await runYamlRecipe(recipe, flatDeps());
    const rows = readRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.recipeSha256).toBe(sha(FLAT_YAML));
  });

  it("chained runner, bridge path (startRun → completeRun)", async () => {
    const file = writeRecipe("noisy-chained.yaml", CHAINED_YAML);
    const recipe = loadYamlRecipe(file) as unknown as ChainedRecipe;
    const runLog = new RecipeRunLog({ dir });
    const res = await runChainedRecipe(
      recipe,
      { env: {}, maxConcurrency: 4, maxDepth: 3, dryRun: false, runLog },
      chainedDeps,
    );
    expect(res.success).toBe(true);
    const rows = readRows(dir);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) expect(r.recipeSha256).toBe(sha(CHAINED_YAML));
  });

  it("chained runner, CLI path (appendDirect)", async () => {
    const file = writeRecipe("noisy-chained.yaml", CHAINED_YAML);
    const recipe = loadYamlRecipe(file) as unknown as ChainedRecipe;
    await runChainedRecipe(
      recipe,
      {
        env: {},
        maxConcurrency: 4,
        maxDepth: 3,
        dryRun: false,
        runLogDir: dir,
      },
      chainedDeps,
    );
    const rows = readRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.recipeSha256).toBe(sha(CHAINED_YAML));
  });

  it("a recipe NOT loaded from a file records no hash (absent, never invented)", async () => {
    const recipe = loadYamlRecipe(writeRecipe("noisy-recipe.yaml", FLAT_YAML));
    // A copy is a different object: nothing proves which bytes it came from.
    await runYamlRecipe({ ...recipe }, flatDeps());
    const rows = readRows(dir);
    expect(rows).toHaveLength(1);
    expect("recipeSha256" in (rows[0] ?? {})).toBe(false);
  });
});

describe("the field survives every store's reader", () => {
  const H = "a".repeat(64);
  const base = {
    taskId: "yaml:noisy-recipe:1",
    recipeName: "noisy-recipe",
    trigger: "cron" as const,
    createdAt: 1_000,
  };

  it("runs.jsonl → a fresh RecipeRunLog", () => {
    const log = new RecipeRunLog({ dir });
    const seq = log.startRun({ ...base, recipeSha256: H });
    log.completeRun(seq, {
      status: "done",
      doneAt: 2_000,
      durationMs: 1_000,
      stepResults: [],
    });
    const reread = new RecipeRunLog({ dir });
    expect(reread.getByTaskId(base.taskId)?.recipeSha256).toBe(H);
  });

  const openSqlite = () => {
    const r = new SqliteRunRepository({ dir });
    opened.push(r);
    return r;
  };

  it("sqlite store: startRun → completeRun → query", () => {
    const repo = openSqlite();
    const seq = repo.startRun({ ...base, recipeSha256: H });
    repo.completeRun(seq, {
      status: "done",
      doneAt: 2_000,
      durationMs: 1_000,
      stepResults: [],
    });
    expect(repo.query()[0]?.recipeSha256).toBe(H);
    // And after reopening the database.
    expect(openSqlite().getBySeq(seq)?.recipeSha256).toBe(H);
  });

  it("sqlite store: appendDirect and mirrorRow", () => {
    const repo = openSqlite();
    repo.appendDirect({
      ...base,
      status: "done",
      doneAt: 2_000,
      durationMs: 1_000,
      recipeSha256: H,
    });
    const mirrored: RecipeRun = {
      ...base,
      taskId: "yaml:noisy-recipe:2",
      seq: 99,
      status: "done",
      doneAt: 2_000,
      durationMs: 1_000,
      recipeSha256: H,
    };
    repo.mirrorRow(mirrored);
    const byTask = new Map(repo.query().map((r) => [r.taskId, r]));
    expect(byTask.get(base.taskId)?.recipeSha256).toBe(H);
    expect(byTask.get(mirrored.taskId)?.recipeSha256).toBe(H);
  });

  it("the bridge's sqlite mirror receives the field from the run log", () => {
    const repo = openSqlite();
    const log = new RecipeRunLog({
      dir,
      mirror: (run) => repo.mirrorRow(run),
    });
    const seq = log.startRun({ ...base, recipeSha256: H });
    log.completeRun(seq, {
      status: "done",
      doneAt: 2_000,
      durationMs: 1_000,
      stepResults: [],
    });
    const row = repo.query()[0];
    expect(row?.status).toBe("done");
    expect(row?.recipeSha256).toBe(H);
  });

  it("sqlite store: a row without the field reads back WITHOUT it", () => {
    const repo = openSqlite();
    repo.startRun(base);
    expect("recipeSha256" in (repo.query()[0] ?? {})).toBe(false);
  });

  it("sqlite store: a database created before the column existed is migrated, old rows stay unrecorded", async () => {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const { DatabaseSync } =
      require("node:sqlite") as typeof import("node:sqlite");
    const legacy = new DatabaseSync(path.join(dir, "runs.db"));
    legacy.exec(`CREATE TABLE runs (
      task_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, recipe_name TEXT NOT NULL,
      trigger TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
      started_at INTEGER, done_at INTEGER, duration_ms INTEGER, model TEXT,
      output_tail TEXT, error_message TEXT, parent_seq INTEGER,
      manual_run_id TEXT, owner_pid INTEGER, had_step_errors INTEGER,
      step_results TEXT, extra TEXT)`);
    legacy
      .prepare(
        "INSERT INTO runs (task_id, seq, recipe_name, trigger, status, created_at, done_at, duration_ms) VALUES ('old:1', 1, 'noisy-recipe', 'cron', 'done', 1, 2, 1)",
      )
      .run();
    legacy.close();

    const repo = openSqlite();
    const old = repo.query().find((r) => r.taskId === "old:1");
    expect(old).toBeDefined();
    expect("recipeSha256" in (old ?? {})).toBe(false);
    repo.startRun({ ...base, recipeSha256: H });
    expect(
      repo.query().find((r) => r.taskId === base.taskId)?.recipeSha256,
    ).toBe(H);
  });
});

describe("2. the plan says what it was built from", () => {
  it("runRecipeDryPlan carries the sha256 of the file it planned", async () => {
    const file = writeRecipe("noisy-recipe.yaml", FLAT_YAML);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const plan = await runRecipeDryPlan(file);
      expect(plan.recipeSha256).toBe(sha(FLAT_YAML));
      const chained = await runRecipeDryPlan(
        writeRecipe("noisy-chained.yaml", CHAINED_YAML),
      );
      expect(chained.recipeSha256).toBe(sha(CHAINED_YAML));
    } finally {
      warn.mockRestore();
    }
  });
});

// ── 3. the run-plan routes compare ─────────────────────────────────────────

function makeReq(method: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  return req;
}
async function call(url: string, deps: Partial<RecipeRouteDeps>) {
  let status = 0;
  let body = "";
  let done: () => void = () => {};
  const finished = new Promise<void>((r) => {
    done = r;
  });
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(b?: string) {
      body = b ?? "";
      done();
      return this;
    },
  } as unknown as ServerResponse;
  tryHandleRecipeRoute(
    makeReq("GET"),
    res,
    new URL(`http://x${url}`),
    deps as unknown as RecipeRouteDeps,
  );
  await finished;
  return { status, body: JSON.parse(body) as Record<string, unknown> };
}

describe("3. both run-plan routes report whether the recipe changed", () => {
  const RAN = "1".repeat(64);
  const NOW = "2".repeat(64);
  const run = (extra: Record<string, unknown> = {}) => ({
    seq: 7,
    taskId: "yaml:noisy-recipe:1",
    recipeName: "noisy-recipe",
    status: "done",
    ...extra,
  });
  const routes = (r: Record<string, unknown>, planSha?: string) => ({
    runDetailFn: (seq: number) => (seq === 7 ? r : null),
    runDetailByTaskFn: (t: string) => (t === r.taskId ? r : null),
    runPlanFn: async (name: string) => ({
      recipe: name,
      steps: [],
      ...(planSha !== undefined && { recipeSha256: planSha }),
    }),
  });
  const urls = [
    "/runs/7/plan",
    `/runs/by-task/${encodeURIComponent("yaml:noisy-recipe:1")}/plan`,
  ];

  for (const url of urls) {
    describe(url.startsWith("/runs/7") ? "by seq" : "by taskId", () => {
      it("a later edit → recipeChangedSinceRun: true", async () => {
        const out = await call(url, routes(run({ recipeSha256: RAN }), NOW));
        expect(out.status).toBe(200);
        expect(out.body.basis).toBe("current");
        expect(out.body.recordedRecipeSha256).toBe(RAN);
        expect(out.body.recipeChangedSinceRun).toBe(true);
        // Backward compatible: the plan is still where it was.
        expect((out.body.plan as Record<string, unknown>).recipe).toBe(
          "noisy-recipe",
        );
        expect((out.body.plan as Record<string, unknown>).recipeSha256).toBe(
          NOW,
        );
      });

      it("unchanged → false", async () => {
        const out = await call(url, routes(run({ recipeSha256: RAN }), RAN));
        expect(out.body.recipeChangedSinceRun).toBe(false);
      });

      it("a run that predates the field → 'unknown', and no recorded hash", async () => {
        const out = await call(url, routes(run(), NOW));
        expect(out.body.recipeChangedSinceRun).toBe("unknown");
        expect("recordedRecipeSha256" in out.body).toBe(false);
        expect(out.body.basis).toBe("current");
      });

      it("a plan with no hash → 'unknown'", async () => {
        const out = await call(url, routes(run({ recipeSha256: RAN })));
        expect(out.body.recipeChangedSinceRun).toBe("unknown");
        expect(out.body.recordedRecipeSha256).toBe(RAN);
      });
    });
  }
});
