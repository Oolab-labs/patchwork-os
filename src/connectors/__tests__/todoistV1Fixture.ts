/**
 * The Todoist v1 wire shape — ONE fixture, shared by every test that mocks it.
 *
 * ## Why this file exists
 *
 * The connector moved to `api/v1` (REST v2 answers 410 Gone) and its TypeScript
 * interfaces kept the v2 field names. Nothing caught it for nine days, because
 * every test hand-wrote its own task body using the same v2 names the code
 * expected. A mock that agrees with the code's wrong assumption proves the code
 * agrees with itself.
 *
 * The consequence was not cosmetic. `observeTask` read `is_completed`, which v1
 * does not send, so an errand the operator really had completed graded
 * `unknown` / `open-recent` instead of `confirmed` — the Butler trust channel
 * could not report a completion at all. It read `created_at` too, which v1 also
 * does not send, so `Date.parse` returned NaN and the "unparseable" fallback
 * substituted `Date.now()`, resetting every errand's age on every run and
 * putting the 14-day `stale-unactioned` horizon permanently out of reach.
 *
 * So: one shape, in one place. Two hand-written shapes is how they drifted.
 *
 * ## Where the key names come from
 *
 * Captured from the live `GET /api/v1/tasks/{id}`, `GET /api/v1/projects` and
 * `GET /api/v1/labels` on 2026-08-19 — **key names only**. The response bodies
 * were never recorded and must never be: a real Todoist account's task content
 * is the operator's errands, and this repository is world-readable. Every value
 * below is synthetic; only the set of keys is evidence.
 *
 * `TODOIST_V1_TASK_KEYS` is exported so a test can assert the fixture still
 * carries the full observed key set. That guard is worth exactly what it says
 * and no more: it detects a fixture drifting from the recorded shape, not the
 * API drifting from the recording. Re-capture when Todoist versions the API.
 */

/**
 * Every key the live v1 task object carried, sorted.
 *
 * Note what is ABSENT and was declared: `is_completed`, `created_at`, `url`,
 * `order`, `comment_count`, `creator_id`, `assignee_id`, `assigner_id`.
 */
export const TODOIST_V1_TASK_KEYS = [
  "added_at",
  "added_by_uid",
  "assigned_by_uid",
  "checked",
  "child_order",
  "completed_at",
  "completed_by_uid",
  "completed_count",
  "content",
  "day_order",
  "deadline",
  "description",
  "due",
  "duration",
  "id",
  "is_collapsed",
  "is_deleted",
  "labels",
  "note_count",
  "parent_id",
  "postponed_count",
  "priority",
  "project_id",
  "responsible_uid",
  "section_id",
  "updated_at",
  "user_id",
] as const;

/**
 * A v1 task body as the API actually sends it.
 *
 * Deliberately a plain `Record` rather than the connector's `TodoistTask`: a
 * fixture typed as the interface it is meant to catch drifting cannot catch it
 * drifting. The compiler would have accepted the old v2 body against the old
 * v2 interface, which is precisely what happened.
 */
export function todoistV1Task(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    added_at: "2026-01-01T00:00:00.000000Z",
    added_by_uid: "10000001",
    assigned_by_uid: null,
    checked: false,
    child_order: 1,
    completed_at: null,
    completed_by_uid: null,
    completed_count: 0,
    content: "example task",
    day_order: -1,
    deadline: null,
    description: "",
    due: null,
    duration: null,
    id: "task1",
    is_collapsed: false,
    is_deleted: false,
    labels: [],
    note_count: 0,
    parent_id: null,
    postponed_count: 0,
    priority: 1,
    project_id: "proj1",
    responsible_uid: null,
    section_id: null,
    updated_at: "2026-01-01T00:00:00.000000Z",
    user_id: "10000001",
    ...overrides,
  };
}

/** A completed v1 task: `checked` true and a `completed_at` stamp. */
export function todoistV1CompletedTask(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return todoistV1Task({
    checked: true,
    completed_at: "2026-01-02T00:00:00.000000Z",
    completed_by_uid: "10000001",
    completed_count: 1,
    ...overrides,
  });
}

/**
 * A v1 project body.
 *
 * Note the asymmetry, which is real and not a transcription slip: projects DO
 * carry `created_at`, tasks carry `added_at`. Declaring `created_at` on the
 * task interface was therefore plausible enough to survive review.
 */
export function todoistV1Project(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    access: null,
    can_assign_tasks: false,
    can_comment: true,
    child_order: 0,
    color: "charcoal",
    created_at: "2026-01-01T00:00:00.000000Z",
    creator_uid: "10000001",
    default_order: 0,
    description: "",
    id: "proj1",
    inbox_project: true,
    is_archived: false,
    is_collapsed: false,
    is_deleted: false,
    is_favorite: false,
    is_frozen: false,
    is_shared: false,
    name: "Example project",
    order_key: "a",
    parent_id: null,
    public_access: null,
    public_key: null,
    role: null,
    updated_at: "2026-01-01T00:00:00.000000Z",
    view_style: "list",
    ...overrides,
  };
}

/** Wrap items in the v1 list envelope. Single-resource endpoints do not use it. */
export function todoistV1List(
  results: unknown[],
  nextCursor: string | null = null,
): Record<string, unknown> {
  return { results, next_cursor: nextCursor };
}
