/**
 * The connector against the shape the v1 API actually sends.
 *
 * ## The bug these tests reproduce
 *
 * `TODOIST_BASE` moved to `api/v1` when REST v2 started answering 410 Gone. The
 * response interfaces did not move with it. Six declared fields do not exist on
 * the v1 wire, and two of them are read to make a decision:
 *
 *   is_completed → the live field is `checked`
 *   created_at   → the live field is `added_at`
 *
 * Measured live on 2026-08-19: a Butler errand the operator had genuinely
 * completed (`checked: true`, `completed_at` set) came back from
 * `patchwork butler observe` as `unknown` / `open-recent`. The observation
 * channel could not report a completion, so no filing could ever earn trust —
 * and it failed *quietly*, reporting "3 observed, 0 unavailable" the whole time.
 *
 * The `created_at` half is worse for being invisible. `Date.parse(undefined)` is
 * NaN, and the guard against an unparseable stamp substitutes `Date.now()`. That
 * guard is right about 1970 and wrong here: it converted a schema mismatch into
 * "this errand was created just now", on every run, so the 14-day
 * `stale-unactioned → junk` horizon can never be reached. The rule that turns
 * silence into a negative was dead and nothing said so.
 *
 * ## Why the existing tests could not catch it
 *
 * `todoist.test.ts` mocks fetch with a hand-written body carrying the v2 names —
 * including inside the `describe("Todoist API v1 …")` block added by the
 * migration itself. And `todoistObservation.test.ts` doubles the *connector*,
 * returning an already-mapped `{kind:"observed", completed, createdAt}`: its
 * seam starts one layer below where the bug lives. Both suites were green
 * throughout.
 *
 * So every test here drives real bytes through `observeTask` / `getTasks` /
 * `getProjects` / `getLabels` from the shared v1 fixture.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  TODOIST_V1_TASK_KEYS,
  todoistV1CompletedTask,
  todoistV1List,
  todoistV1Project,
  todoistV1Task,
} from "./todoistV1Fixture.js";

/**
 * Token storage resolves under PATCHWORK_HOME. `TODOIST_API_KEY` short-circuits
 * it, but a stray real-store read is the failure mode this connector's other
 * suite documents at length, so the sandbox is set regardless.
 */
const SANDBOX_HOME = mkdtempSync(join(os.tmpdir(), "todoist-v1-shape-"));

beforeEach(() => {
  process.env.PATCHWORK_HOME = SANDBOX_HOME;
  process.env.TODOIST_API_KEY = "test-token";
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TODOIST_API_KEY;
  // Re-point at the sandbox rather than deleting: with PATCHWORK_HOME unset the
  // token store resolves to the developer's real ~/.patchwork, and this
  // connector's other suite documents a live credential deleted exactly that
  // way. Overriding HOME is not a substitute — os.homedir() falls back to the
  // passwd entry, so a HOME-based sandbox is a check that cannot fail.
  process.env.PATCHWORK_HOME = SANDBOX_HOME;
});

afterAll(() => {
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
});

function mockJson(body: unknown, ok = true, status = 200) {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
    headers: { get: () => null },
  }) as unknown as typeof fetch;
}

async function connector() {
  const { TodoistConnector } = await import("../todoist.js");
  return new TodoistConnector();
}

// ── the fixture is the recorded shape ────────────────────────────────────────

describe("the v1 fixture matches what was captured from the live API", () => {
  it("carries exactly the observed key set", () => {
    // Guards the fixture, not the API. If someone "tidies" a key out of the
    // fixture to make a test pass, the tests below stop meaning anything.
    expect(Object.keys(todoistV1Task()).sort()).toEqual([
      ...TODOIST_V1_TASK_KEYS,
    ]);
  });

  it("does not carry the v2 names the interface used to declare", () => {
    const task = todoistV1Task();
    for (const absent of [
      "is_completed",
      "created_at",
      "url",
      "order",
      "comment_count",
      "creator_id",
      "assignee_id",
      "assigner_id",
    ]) {
      expect(task).not.toHaveProperty(absent);
    }
  });
});

// ── observeTask: the decision path ───────────────────────────────────────────

describe("observeTask reads the fields v1 actually sends", () => {
  it("reports a completed task as completed", async () => {
    // THE regression. Before the fix this returns completed:false, and a real
    // operator completion grades `unknown` / `open-recent` forever.
    mockJson(todoistV1CompletedTask());

    const result = await (await connector()).observeTask("task1");

    expect(result).toMatchObject({ kind: "observed", completed: true });
  });

  it("reports an open task as open", async () => {
    mockJson(todoistV1Task());

    const result = await (await connector()).observeTask("task1");

    expect(result).toMatchObject({ kind: "observed", completed: false });
  });

  it("takes createdAt from added_at, not a fabricated now", async () => {
    // The staleness horizon is measured from this. Substituting Date.now()
    // makes every errand permanently "recent", so `stale-unactioned` — the
    // branch that converts silence into a negative — becomes unreachable.
    mockJson(todoistV1Task({ added_at: "2026-01-01T00:00:00.000000Z" }));

    const result = await (await connector()).observeTask("task1");

    expect(result.kind).toBe("observed");
    if (result.kind !== "observed") throw new Error("expected an observation");
    expect(result.createdAt).toBe(Date.parse("2026-01-01T00:00:00.000000Z"));
  });

  it("omits createdAt rather than inventing one when added_at is unusable", async () => {
    // Two wrong answers were available and both are harms. Zero reads as 1970,
    // which the horizon grades `junk` — a negative manufactured from a parse
    // failure. `Date.now()` reads as brand new, which is what masked this bug
    // for nine days. Neither is an observation of age, so we report none: the
    // grader answers `not-observed` on the staleness branch, while `completed`
    // is still checked FIRST and a real completion survives.
    mockJson(todoistV1Task({ added_at: "not-a-date" }));

    const result = await (await connector()).observeTask("task1");

    expect(result.kind).toBe("observed");
    if (result.kind !== "observed") throw new Error("expected an observation");
    expect(result.createdAt).toBeUndefined();
  });

  it("still confirms a completion whose added_at is unusable", async () => {
    mockJson(todoistV1CompletedTask({ added_at: "not-a-date" }));

    const result = await (await connector()).observeTask("task1");

    expect(result).toMatchObject({ kind: "observed", completed: true });
  });
});

// ── the end-to-end path the operator actually runs ───────────────────────────

describe("a real completion survives the whole observation chain", () => {
  it("grades a checked:true task as confirmed", async () => {
    // observeTask → observeTodoistErrands → gradeErrandOutcome, with a real v1
    // body at the top. This is the chain `patchwork butler observe` runs, and
    // the one that returned `unknown` against a genuinely completed errand.
    mockJson(todoistV1CompletedTask());

    const { observeTodoistErrands } = await import(
      "../../butler/todoistObservation.js"
    );
    const { gradeErrandOutcome } = await import(
      "../../butler/errandOutcomeGrader.js"
    );

    const run = await observeTodoistErrands(await connector(), [
      { taskId: "task1", ref: "todoist.create_task:task1", recipe: "errands" },
    ]);

    expect(run.unavailable).toEqual([]);
    const observation = run.observations[0];
    if (!observation) throw new Error("expected an observation");
    expect(gradeErrandOutcome(observation, { now: Date.now() })).toEqual({
      disposition: "confirmed",
      reason: "completed",
    });
  });

  it("an old open task still reaches the staleness horizon", async () => {
    // The other half: with createdAt read correctly, silence can once again
    // become a negative. A fabricated `Date.now()` makes this row `open-recent`
    // for ever.
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    mockJson(todoistV1Task({ added_at: sixtyDaysAgo.toISOString() }));

    const { observeTodoistErrands } = await import(
      "../../butler/todoistObservation.js"
    );
    const { gradeErrandOutcome } = await import(
      "../../butler/errandOutcomeGrader.js"
    );

    const run = await observeTodoistErrands(await connector(), [
      { taskId: "task1", ref: "todoist.create_task:task1" },
    ]);
    const observation = run.observations[0];
    if (!observation) throw new Error("expected an observation");

    expect(
      gradeErrandOutcome(
        { ...observation, watchedSince: sixtyDaysAgo.getTime() },
        { now: Date.now() },
      ),
    ).toEqual({ disposition: "junk", reason: "stale-unactioned" });
  });
});

// ── the list endpoints ───────────────────────────────────────────────────────

describe("list endpoints against real v1 bodies", () => {
  it("getTasks unwraps the envelope and preserves the v1 keys", async () => {
    mockJson(todoistV1List([todoistV1Task(), todoistV1Task({ id: "task2" })]));

    const tasks = await (await connector()).getTasks();

    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toHaveProperty("checked");
    expect(tasks[0]).toHaveProperty("added_at");
  });

  it("getProjects unwraps the envelope", async () => {
    mockJson(todoistV1List([todoistV1Project()]));

    const projects = await (await connector()).getProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]).toHaveProperty("child_order");
  });

  it("getLabels unwraps the envelope like its siblings", async () => {
    // It did not. `getLabels` was the one list endpoint the v1 migration
    // missed, so it returned `{results, next_cursor}` typed as an array — every
    // caller's `.length` is undefined and `.map` throws. Latent rather than
    // live only because nothing calls it yet, which is not a reason to leave it.
    mockJson(todoistV1List([]));

    const labels = await (await connector()).getLabels();

    expect(Array.isArray(labels)).toBe(true);
  });
});
