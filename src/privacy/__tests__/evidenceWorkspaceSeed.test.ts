/**
 * The evidence workspace tag records WHICH PROCESS wrote the row, not which
 * workspace produced it.
 *
 * #1455 tagged evidence records with a short workspace id. `evidenceWorkspaceId()`
 * in `yamlRunner` resolves it with a bare `resolveWorkspaceRoot()` — and that
 * function, given no `startDir`, walks up from `process.cwd()` looking for a
 * `.git` marker. So the tag describes the writing process's working directory,
 * never the workspace the bridge was pointed at.
 *
 * Measured on the live deployment, and the measurement is the argument:
 *
 *   bridge A   cwd = the home directory   no `.git` ancestor → UNTAGGED
 *   bridge B   cwd = the checkout          `.git` found       → tagged
 *
 * Both lock files record the SAME `workspace`. So two identically-configured
 * bridges serving one workspace disagreed about its identity, and the ledger
 * recorded which of them happened to take the call. 22 of 40 shadow rows carried
 * a tag; 0 of 4 boundary receipts did.
 *
 * A partially-populated field is worse than an empty one here: rows carrying a
 * tag invite the conclusion that tagging works.
 *
 * Two sibling call sites already do this correctly and neither was copied:
 *
 *   recipeOrchestration.ts:1607   currentWorkspaceId(this.deps.workdir)
 *   claudeOrchestrator.ts:532     resolveWorkspaceRoot({ startDir: this.workspace })
 *
 * `stepDeps.workdir` is the right seed and is already present at this seam —
 * it is the same object `recipeName` was taken from in #1474, and `bridge.ts`
 * fills it from `config.workspace`.
 *
 * NOT backfilled. `workspaceId.ts` says an omitted field "says nothing" while a
 * populated one asserts somebody looked — rewriting history to assert a
 * workspace nobody recorded is the error that module exists to avoid.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { currentWorkspaceId } from "../../workspaceId.js";

let dir: string;
let home: string;
let workdir: string;

beforeEach(() => {
  dir = mkdtempSync(join(os.tmpdir(), "ws-seed-"));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });

  // A workspace that is NOT an ancestor of the test process's cwd, and that
  // carries its own `.git` marker so the resolver stops there. Without the
  // marker the walk would climb out of the temp tree and the assertion could
  // not tell a fixed implementation from a lucky one.
  workdir = join(dir, "a-workspace");
  mkdirSync(join(workdir, ".git"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeShadowOnlyConfig(): void {
  // `privacy.shadow`, not `privacy.destinations`: this test is about the tag on
  // the row, so it must not also turn enforcement on.
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      privacy: {
        shadow: {
          destinations: {
            "test-local": {
              type: "local",
              classifications: ["public", "internal"],
              drivers: ["local"],
            },
          },
        },
      },
    }),
  );
}

function writeEnforcingConfig(): void {
  // The ENFORCING key. The receipt log is the ledger ADR-0021 calls the audit
  // record, and it was the one with 0 of 4 rows tagged — so it needs its own
  // case rather than riding on the shadow assertions. Without it, reverting the
  // seed at the receipt call site alone leaves every test green.
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      privacy: {
        destinations: {
          "test-local": {
            type: "local",
            classifications: ["public", "internal"],
            drivers: ["local"],
          },
        },
      },
    }),
  );
}

function receipts(): Array<{ workspaceId?: string }> {
  return readFileSync(join(home, "boundary_receipts.jsonl"), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { workspaceId?: string });
}

async function run(): Promise<Array<{ workspaceId?: string }>> {
  const prev = process.env.PATCHWORK_HOME;
  const prevWs = process.env.PATCHWORK_WORKSPACE;
  process.env.PATCHWORK_HOME = home;
  // Unset so the resolver cannot reach the answer by env — the point is that
  // the SEED is wrong, and an env var would mask it.
  delete process.env.PATCHWORK_WORKSPACE;
  try {
    const { runYamlRecipe } = await import("../../recipes/yamlRunner.js");
    await runYamlRecipe(
      {
        name: "tagged-recipe",
        trigger: { type: "manual" },
        steps: [{ agent: { prompt: "hi", driver: "local" } }],
      } as never,
      {
        testMode: true,
        logDir: dir,
        workdir,
        now: () => new Date("2026-08-19T00:00:00Z"),
        readFile: () => {
          throw new Error("nope");
        },
        writeFile: () => {},
        appendFile: () => {},
        mkdir: () => {},
        gitLogSince: () => "",
        gitStaleBranches: () => "",
        getDiagnostics: () => "",
        claudeFn: async () => "ok",
      } as never,
    );
    // Absent under an enforcing-only config, which is a valid state for this
    // helper rather than a failure — the receipt case asserts on its own file.
    try {
      return readFileSync(join(home, "privacy_shadow.jsonl"), "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { workspaceId?: string });
    } catch {
      return [];
    }
  } finally {
    if (prev === undefined) delete process.env.PATCHWORK_HOME;
    else process.env.PATCHWORK_HOME = prev;
    if (prevWs !== undefined) process.env.PATCHWORK_WORKSPACE = prevWs;
  }
}

describe("the evidence tag names the workspace, not the writing process's cwd", () => {
  it("tags the row with the workspace the run was given", async () => {
    writeShadowOnlyConfig();

    const rows = await run();
    expect(rows.length).toBeGreaterThan(0);

    // The discriminating assertion. Before the fix this is the id of whatever
    // repo the TEST RUNNER happens to sit in — a real id, on the wrong
    // workspace, which is precisely why the defect survived: the field was
    // populated and plausible.
    expect(rows.at(-1)?.workspaceId).toBe(currentWorkspaceId(workdir));
  });

  it("does not tag it with the process's own workspace", async () => {
    writeShadowOnlyConfig();

    const rows = await run();
    const cwdId = currentWorkspaceId(process.cwd());

    // Guard against a fix that merely stops resolving: `toBe(workdirId)` above
    // would also pass if BOTH were undefined on some machine. This pins the
    // direction of the error the fix removes.
    expect(rows.at(-1)?.workspaceId).toBeDefined();
    expect(rows.at(-1)?.workspaceId).not.toBe(cwdId);
  });
});

describe("the enforcing receipt ledger is tagged too", () => {
  it("tags a boundary receipt with the run's workspace", async () => {
    writeEnforcingConfig();

    await run();
    const rows = receipts();

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.at(-1)?.workspaceId).toBe(currentWorkspaceId(workdir));
    expect(rows.at(-1)?.workspaceId).not.toBe(
      currentWorkspaceId(process.cwd()),
    );
  });
});
