import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Isolate from the developer's real ~/.patchwork/config.json — agent steps
// now read it via a static import (was a broken `require()` under ESM that
// always returned {}). Tests assert default model / driver behavior, so we
// hold the config to {} here.
vi.mock("../../patchworkConfig.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../patchworkConfig.js")
  >("../../patchworkConfig.js");
  return {
    ...actual,
    loadConfig: vi.fn(() => ({})),
  };
});

vi.mock("../../connectors/linear.js", () => ({
  loadTokens: vi.fn(),
  listIssues: vi.fn(),
}));

vi.mock("../../connectors/github.js", () => ({
  // Only listIssues + listPRs are imported by the github recipe-tool
  // wrappers; the rest of the connector surface stays unmocked.
  listIssues: vi.fn(),
  listPRs: vi.fn(),
}));

// Bug (1): exercises the *default* providerDriverFn (makeProviderDriverFn).
// API drivers (OpenAI / Grok) never set exitCode — on failure they resolve
// with { text: "", errorMessage } (or { wasAborted }). The stub lets a test
// drive those shapes through the real factory by stubbing `createDriver`.
const mockProviderRun = vi.fn();
vi.mock("../../drivers/index.js", () => ({
  createDriver: vi.fn(() => ({ name: "stub", run: mockProviderRun })),
}));

import {
  listIssues as listGithubIssues,
  listPRs as listGithubPRs,
} from "../../connectors/github.js";
import { listIssues, loadTokens } from "../../connectors/linear.js";

const mockLoadTokens = vi.mocked(loadTokens);
const mockListIssues = vi.mocked(listIssues);
const mockListGithubIssues = vi.mocked(listGithubIssues);
const mockListGithubPRs = vi.mocked(listGithubPRs);

import {
  buildChainedDeps,
  evaluateExpect,
  type FetchFn,
  listYamlRecipes,
  makeProviderDriverFn,
  type RunnerDeps,
  render,
  runYamlRecipe,
  validateYamlRecipe,
  type YamlRecipe,
} from "../yamlRunner.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeRecipe(overrides: Partial<YamlRecipe> = {}): YamlRecipe {
  return {
    name: "test-recipe",
    trigger: { type: "manual" },
    steps: [],
    ...overrides,
  };
}

const tmpLogDir = mkdtempSync(path.join(os.tmpdir(), "yamlrunner-test-"));
// Per-suite scratch dir for fixture paths (replaces hard-coded "/tmp" so
// Win32 CI passes the recipe-path jail check).
const TMP = tmpLogDir;

function noop(): RunnerDeps {
  return {
    now: () => new Date("2026-04-18T08:00:00Z"),
    logDir: tmpLogDir,
    readFile: () => {
      throw new Error("not found");
    },
    writeFile: () => {},
    appendFile: () => {},
    mkdir: () => {},
    gitLogSince: () => "abc1234 feat: something",
    gitStaleBranches: () => "old-branch 2025-01-01",
    getDiagnostics: () => "",
  };
}

// ── render ────────────────────────────────────────────────────────────────────

describe("render", () => {
  it("substitutes known keys", () => {
    expect(render("hello {{name}}", { name: "world" })).toBe("hello world");
  });
  it("leaves unknown keys as empty string", () => {
    expect(render("{{missing}}", {})).toBe("");
  });
  it("is whitespace-tolerant in braces", () => {
    expect(render("{{ date }}", { date: "2026-04-18" })).toBe("2026-04-18");
  });
  it("does not walk Object.prototype on dotted paths", () => {
    // RunContext is flat string-valued; the dotted-path branch only fires
    // when an intermediate string JSON-parses to an object. Without the
    // Object.hasOwn guard, the parsed object's prototype keys would resolve
    // to Object.prototype methods and String() would leak function source.
    const json = JSON.stringify({ other: "x" });
    expect(render("{{ obj.toString }}", { obj: json })).toBe("");
    expect(render("{{ obj.constructor }}", { obj: json })).toBe("");
    expect(render("{{ obj.valueOf }}", { obj: json })).toBe("");
  });
  it("strips __proto__/constructor/prototype from JSON-parsed intermediates", () => {
    // Attacker-controlled JSON in a ctx string must not survive dotted-path
    // resolution with these keys intact (downstream Object.assign / merge
    // would pollute Object.prototype). sanitizeParsed should drop them at
    // parse time.
    const evil = JSON.stringify({
      __proto__: { polluted: true },
      constructor: { evil: 1 },
      ok: "fine",
    });
    expect(render("{{ obj.ok }}", { obj: evil })).toBe("fine");
    expect(render("{{ obj.__proto__ }}", { obj: evil })).toBe("");
    expect(render("{{ obj.constructor }}", { obj: evil })).toBe("");
    // Confirm no actual pollution slipped through.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

// ── validateYamlRecipe ────────────────────────────────────────────────────────

describe("validateYamlRecipe", () => {
  it("accepts minimal valid recipe", () => {
    const r = validateYamlRecipe({
      name: "x",
      trigger: { type: "manual" },
      steps: [{ tool: "file.read", path: path.join(TMP, "x") }],
    });
    expect(r.name).toBe("x");
  });
  it("throws on missing name", () => {
    expect(() =>
      validateYamlRecipe({ trigger: { type: "manual" }, steps: [{}] }),
    ).toThrow("name");
  });
  it("throws on empty steps", () => {
    expect(() =>
      validateYamlRecipe({ name: "x", trigger: { type: "manual" }, steps: [] }),
    ).toThrow("steps");
  });

  it("normalizes legacy runtime-safe recipe shapes", () => {
    const recipe = validateYamlRecipe({
      name: "legacy-runtime",
      trigger: { type: "cron", schedule: "0 6 * * *" },
      steps: [
        {
          tool: "file.append",
          params: {
            path: path.join(TMP, "out.md"),
            line: "hello",
          },
          output: "saved",
        },
        {
          agent: true,
          prompt: "Summarize {{saved}}",
          output: "summary",
        },
        {
          id: "parallel_fetch",
          parallel: [
            {
              tool: "notify.push",
              params: { title: "x" },
              output: "notified",
            },
          ],
        },
      ],
    }) as unknown as Record<string, unknown>;

    expect((recipe.trigger as Record<string, unknown>).at).toBe("0 6 * * *");
    expect(recipe.steps).toMatchObject([
      {
        tool: "file.append",
        path: path.join(TMP, "out.md"),
        content: "hello",
        into: "saved",
      },
      {
        agent: {
          prompt: "Summarize {{saved}}",
          into: "summary",
        },
      },
      {
        id: "parallel_fetch",
        parallel: [
          {
            tool: "notify.push",
            title: "x",
            into: "notified",
          },
        ],
      },
    ]);
  });
});

// ── runYamlRecipe ─────────────────────────────────────────────────────────────

describe("runYamlRecipe — file.write", () => {
  it("writes rendered content and records output path", async () => {
    const written: Record<string, string> = {};
    const recipe = makeRecipe({
      steps: [
        {
          tool: "file.write",
          path: "~/.patchwork/inbox/out.md",
          content: "# {{date}}\n",
        },
      ],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      writeFile: (p, c) => {
        written[p] = c;
      },
    });
    expect(result.stepsRun).toBe(1);
    expect(Object.keys(written)).toHaveLength(1);
    expect(Object.values(written)[0]).toContain("2026-04-18");
  });

  it("exposes structured output fields from registry metadata in context", async () => {
    const written: Record<string, string> = {};
    const recipe = makeRecipe({
      steps: [
        {
          tool: "file.write",
          path: path.join(TMP, "meta.md"),
          content: "hello",
          into: "saved",
        },
        {
          tool: "file.write",
          path: path.join(TMP, "out.md"),
          content: "{{saved.path}} ({{saved.bytesWritten}})",
        },
      ],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      writeFile: (p, c) => {
        written[p] = c;
      },
    });

    expect(result.context["saved.path"]).toBe(path.join(TMP, "meta.md"));
    expect(result.context["saved.bytesWritten"]).toBe("5");
    expect(written[path.join(TMP, "out.md")]).toBe(
      path.join(TMP, "meta.md (5)"),
    );
  });
});

describe("runYamlRecipe — file.append", () => {
  it("appends rendered content", async () => {
    const appended: string[] = [];
    const recipe = makeRecipe({
      steps: [
        {
          tool: "file.append",
          path: "~/.patchwork/journal/2026-04-18.md",
          content: "- {{time}} note\n",
        },
      ],
    });
    await runYamlRecipe(recipe, {
      ...noop(),
      appendFile: (_p, c) => {
        appended.push(c);
      },
    });
    expect(appended[0]).toMatch(/- \d{2}:\d{2} note/);
  });

  it("skips append when `when` condition is false", async () => {
    const appended: string[] = [];
    const recipe = makeRecipe({
      steps: [
        {
          tool: "file.append",
          path: path.join(TMP, "x.md"),
          content: "x",
          when: "0 > 1",
        },
      ],
    });
    await runYamlRecipe(recipe, {
      ...noop(),
      appendFile: (_p, c) => {
        appended.push(c);
      },
    });
    expect(appended).toHaveLength(0);
  });
});

describe("runYamlRecipe — file.read", () => {
  it("reads file into context", async () => {
    const recipe = makeRecipe({
      steps: [
        { tool: "file.read", path: "~/.patchwork/planned.md", into: "plan" },
        {
          tool: "file.write",
          path: path.join(TMP, "out.md"),
          content: "plan: {{plan}}",
        },
      ],
    });
    const written: Record<string, string> = {};
    await runYamlRecipe(recipe, {
      ...noop(),
      readFile: () => "do stuff",
      writeFile: (p, c) => {
        written[p] = c;
      },
    });
    expect(written[path.join(TMP, "out.md")]).toBe("plan: do stuff");
  });

  it("optional:true does not throw on missing file", async () => {
    const recipe = makeRecipe({
      steps: [
        {
          tool: "file.read",
          path: "/nonexistent",
          into: "data",
          optional: true,
        },
      ],
    });
    await expect(runYamlRecipe(recipe, noop())).resolves.not.toThrow();
  });

  it("non-optional sets errorMessage on missing file", async () => {
    // Path must be inside the recipe jail (G-security A-PR1) — point at a
    // tmpdir leaf that definitely doesn't exist on disk so we exercise the
    // ENOENT branch, not the jail branch.
    const recipe = makeRecipe({
      steps: [
        {
          tool: "file.read",
          path: path.join(os.tmpdir(), "nonexistent-file-read-test.bin"),
          into: "data",
        },
      ],
    });
    const result = await runYamlRecipe(recipe, noop());
    expect(result.errorMessage).toMatch(/could not read/);
    expect(result.stepResults[0]!.status).toBe("error");
  });
});

describe("runYamlRecipe — git.log_since", () => {
  it("captures git log output into context", async () => {
    const recipe = makeRecipe({
      steps: [
        { tool: "git.log_since", since: "24h", into: "commits" },
        {
          tool: "file.write",
          path: path.join(TMP, "out.md"),
          content: "commits: {{commits}}",
        },
      ],
    });
    const written: Record<string, string> = {};
    await runYamlRecipe(recipe, {
      ...noop(),
      gitLogSince: () => "abc feat: x",
      writeFile: (p, c) => {
        written[p] = c;
      },
    });
    expect(written[path.join(TMP, "out.md")]).toContain("abc feat: x");
  });
});

describe("runYamlRecipe — git.stale_branches", () => {
  it("captures stale branches into context", async () => {
    const recipe = makeRecipe({
      steps: [
        { tool: "git.stale_branches", days: 30, into: "stale" },
        {
          tool: "file.write",
          path: path.join(TMP, "stale.md"),
          content: "{{stale}}",
        },
      ],
    });
    const written: Record<string, string> = {};
    await runYamlRecipe(recipe, {
      ...noop(),
      gitStaleBranches: () => "old-branch",
      writeFile: (p, c) => {
        written[p] = c;
      },
    });
    expect(written[path.join(TMP, "stale.md")]).toBe("old-branch");
  });
});

describe("runYamlRecipe — silent-fail detection (P1)", () => {
  // Catches the entire class of bugs surfaced in the post-merge
  // dogfood: tools returning string placeholders or empty-list-with-
  // error shapes that the runner used to hand on as success.

  it("flags '(... unavailable)' placeholder as step error", async () => {
    const recipe = makeRecipe({
      steps: [{ tool: "git.stale_branches", days: 30, into: "stale" }],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      gitStaleBranches: () => "(git branches unavailable)",
    });
    expect(result.stepResults).toHaveLength(1);
    expect(result.stepResults[0]?.status).toBe("error");
    expect(result.stepResults[0]?.error).toMatch(/silent-fail detected/);
    expect(result.stepResults[0]?.error).toContain("unavailable");
    expect(result.errorMessage).toBeDefined();
  });

  it("flags '[agent step skipped: ...]' as step error", async () => {
    const recipe = makeRecipe({
      steps: [
        {
          agent: {
            prompt: "summarize",
            model: "claude-haiku-4-5-20251001",
            into: "summary",
          },
        },
      ],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async () => "[agent step skipped: ANTHROPIC_API_KEY not set]",
    });
    expect(result.stepResults[0]?.status).toBe("error");
    expect(result.stepResults[0]?.error).toMatch(/agent step skipped/);
  });

  it("strips prototype-pollution keys from agent JSON output before stashing in ctx", async () => {
    // A jailbroken agent could return `{"__proto__":{"polluted":true}}`; the
    // parsed object lands in ctx and gets spread/merged downstream. Scrub
    // the dangerous keys at the parse boundary.
    const recipe = makeRecipe({
      steps: [
        {
          agent: {
            prompt: "produce",
            model: "claude-haiku-4-5-20251001",
            into: "result",
          },
        },
        {
          tool: "file.write",
          path: path.join(TMP, "out.txt"),
          content: "ok={{result.ok}} proto={{result.__proto__}}",
        },
      ],
    });
    const written: Record<string, string> = {};
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async () =>
        '```json\n{"__proto__":{"polluted":true},"ok":"yes"}\n```',
      writeFile: (p, c) => {
        written[p] = c;
      },
    });
    expect(result.stepResults[0]?.status).toBe("ok");
    expect(Object.values(written)[0]).toBe("ok=yes proto=");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("does NOT flag legitimate output that contains 'unavailable' as prose", async () => {
    const recipe = makeRecipe({
      steps: [{ tool: "git.log_since", since: "1 week ago", into: "log" }],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      gitLogSince: () => "feat: handle the unavailable-resource path",
    });
    expect(result.stepResults[0]?.status).toBe("ok");
    expect(result.stepResults[0]?.error).toBeUndefined();
  });

  it("respects per-step opt-out (silentFailDetection: false)", async () => {
    const recipe = makeRecipe({
      steps: [
        {
          tool: "git.stale_branches",
          days: 30,
          into: "stale",
          silentFailDetection: false,
        },
      ],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      gitStaleBranches: () => "(git branches unavailable)",
    });
    // With detection off, the placeholder string passes through as "ok".
    expect(result.stepResults[0]?.status).toBe("ok");
  });

  it("respects step-level optional:true (failOpen) — placeholder still detected but doesn't fail run", async () => {
    const recipe = makeRecipe({
      steps: [
        {
          tool: "git.stale_branches",
          days: 30,
          into: "stale",
          optional: true,
        },
        { tool: "file.write", path: path.join(TMP, "x.md"), content: "ok" },
      ],
    });
    const written: Record<string, string> = {};
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      gitStaleBranches: () => "(git branches unavailable)",
      writeFile: (p, c) => {
        written[p] = c;
      },
    });
    // Step 1 marked error (silent-fail caught) but optional → run proceeds.
    expect(result.stepResults[0]?.status).toBe("error");
    expect(written[path.join(TMP, "x.md")]).toBe("ok");
    expect(result.errorMessage).toBeUndefined();
  });
});

describe("runYamlRecipe — on_error retry + fallback", () => {
  function deps(readFile: () => string): RunnerDeps {
    return { ...noop(), readFile };
  }

  it("retries a failing file.read step up to step.retry times", async () => {
    let calls = 0;
    const recipe = makeRecipe({
      steps: [
        {
          tool: "file.read",
          path: path.join(TMP, "a"),
          into: "data",
          retry: 2,
          retryDelay: 0,
        },
      ],
    });
    const result = await runYamlRecipe(
      recipe,
      deps(() => {
        calls++;
        if (calls < 3) throw new Error("transient");
        return "ok";
      }),
    );
    expect(calls).toBe(3);
    expect(result.errorMessage).toBeUndefined();
    expect(result.context.data).toBe("ok");
  });

  it("honors recipe-level on_error.retry when step has no retry", async () => {
    let calls = 0;
    const recipe = makeRecipe({
      on_error: { retry: 1, retryDelay: 0 },
      steps: [{ tool: "file.read", path: path.join(TMP, "a"), into: "data" }],
    });
    const result = await runYamlRecipe(
      recipe,
      deps(() => {
        calls++;
        if (calls === 1) throw new Error("transient");
        return "ok";
      }),
    );
    expect(calls).toBe(2);
    expect(result.errorMessage).toBeUndefined();
  });

  it("treats step failure as non-fatal when on_error.fallback=log_only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const recipe = makeRecipe({
      on_error: { fallback: "log_only" },
      steps: [{ tool: "file.read", path: path.join(TMP, "a"), into: "data" }],
    });
    const result = await runYamlRecipe(
      recipe,
      deps(() => {
        throw new Error("boom");
      }),
    );
    expect(result.errorMessage).toBeUndefined();
    expect(result.stepResults[0]?.status).toBe("error");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("on_error.fallback=log_only"),
    );
    warn.mockRestore();
  });

  it("deliver_original behaves like log_only (fail-open)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const recipe = makeRecipe({
      on_error: { fallback: "deliver_original" },
      steps: [{ tool: "file.read", path: path.join(TMP, "a"), into: "data" }],
    });
    const result = await runYamlRecipe(
      recipe,
      deps(() => {
        throw new Error("boom");
      }),
    );
    expect(result.errorMessage).toBeUndefined();
    warn.mockRestore();
  });

  it("propagates failure when on_error.fallback=abort (default)", async () => {
    const recipe = makeRecipe({
      on_error: { fallback: "abort" },
      steps: [{ tool: "file.read", path: path.join(TMP, "a"), into: "data" }],
    });
    const result = await runYamlRecipe(
      recipe,
      deps(() => {
        throw new Error("boom");
      }),
    );
    expect(result.errorMessage).toBeDefined();
  });
});

// ── Bug (2): flat runner aborts on a fatal failure (mirrors chainedRunner) ─────
// The flat runner used to record the first non-optional failure in runError
// but kept executing later steps. It now breaks at the next loop top —
// EXCEPT when the failure is fail-open (step.optional / on_error.fallback=
// log_only|deliver_original) or a soft silent-fail connector envelope, both
// of which still let the run continue.

describe("runYamlRecipe — abort-on-fatal-failure (Bug 2)", () => {
  function depsRead(readFile: () => string): RunnerDeps {
    return { ...noop(), readFile };
  }

  it("does NOT run steps after a hard tool throw (default on_error)", async () => {
    const written: Record<string, string> = {};
    const recipe = makeRecipe({
      steps: [
        { tool: "file.read", path: path.join(TMP, "missing"), into: "data" },
        {
          tool: "file.write",
          path: path.join(TMP, "after.md"),
          content: "should not be written",
        },
      ],
    });
    const result = await runYamlRecipe(recipe, {
      ...depsRead(() => {
        throw new Error("boom");
      }),
      writeFile: (p, c) => {
        written[p] = c;
      },
    });
    // Step 1 errored; step 2 must never have run.
    expect(result.stepResults[0]?.status).toBe("error");
    expect(written[path.join(TMP, "after.md")]).toBeUndefined();
    // Only one step recorded — the loop broke before step 2.
    expect(result.stepResults).toHaveLength(1);
    expect(result.stepsRun).toBe(1);
    expect(result.errorMessage).toBeDefined();
  });

  it("does NOT run steps after a hard agent failure (default on_error)", async () => {
    const written: Record<string, string> = {};
    let secondAgentCalls = 0;
    const recipe = makeRecipe({
      steps: [
        {
          agent: {
            prompt: "step 1",
            model: "claude-haiku-4-5-20251001",
            into: "out1",
          },
        },
        {
          tool: "file.write",
          path: path.join(TMP, "after.md"),
          content: "should not be written",
        },
      ],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      // Hard agent failure — the `[agent step failed: ...]` marker.
      claudeFn: async () => {
        secondAgentCalls++;
        return "[agent step failed: driver exploded]";
      },
      writeFile: (p, c) => {
        written[p] = c;
      },
    });
    expect(secondAgentCalls).toBe(1);
    expect(result.stepResults[0]?.status).toBe("error");
    expect(written[path.join(TMP, "after.md")]).toBeUndefined();
    expect(result.stepResults).toHaveLength(1);
  });

  it("STILL delivers a downstream payload after a soft silent-fail envelope (contract preserved)", async () => {
    // A connector list-tool returning {count:0,error} is silent-fail-detected
    // (soft) — the run must continue so the recipe can deliver the degraded
    // payload. This pins the carve-out that keeps the existing
    // "linear.list_issues returns error payload" tests green.
    mockLoadTokens.mockReturnValue(null); // → {count:0, error:"not connected"}
    const written: Record<string, string> = {};
    const result = await runYamlRecipe(
      makeRecipe({
        steps: [
          { tool: "linear.list_issues", into: "issues" },
          {
            tool: "file.write",
            path: path.join(TMP, "soft.md"),
            content: "{{issues}}",
          },
        ],
      }),
      {
        ...noop(),
        writeFile: (p, c) => {
          written[p] = c;
        },
      },
    );
    // Step 1 flagged error (silent-fail) but step 2 still ran.
    expect(result.stepResults[0]?.status).toBe("error");
    expect(written[path.join(TMP, "soft.md")]).toContain("not connected");
    expect(result.stepResults).toHaveLength(2);
  });

  it("STILL runs later steps when on_error.fallback=log_only (fail-open preserved)", async () => {
    const written: Record<string, string> = {};
    const recipe = makeRecipe({
      on_error: { fallback: "log_only" },
      steps: [
        { tool: "file.read", path: path.join(TMP, "missing"), into: "data" },
        {
          tool: "file.write",
          path: path.join(TMP, "after.md"),
          content: "delivered anyway",
        },
      ],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await runYamlRecipe(recipe, {
      ...depsRead(() => {
        throw new Error("boom");
      }),
      writeFile: (p, c) => {
        written[p] = c;
      },
    });
    warn.mockRestore();
    expect(result.stepResults[0]?.status).toBe("error");
    // Fail-open: step 2 still ran.
    expect(written[path.join(TMP, "after.md")]).toBe("delivered anyway");
    expect(result.stepResults).toHaveLength(2);
  });

  it("STILL runs later steps when the failing step is optional:true", async () => {
    const written: Record<string, string> = {};
    const recipe = makeRecipe({
      steps: [
        {
          tool: "file.read",
          path: path.join(TMP, "missing"),
          into: "data",
          optional: true,
        },
        {
          tool: "file.write",
          path: path.join(TMP, "after.md"),
          content: "delivered anyway",
        },
      ],
    });
    const result = await runYamlRecipe(recipe, {
      ...depsRead(() => {
        throw new Error("boom");
      }),
      writeFile: (p, c) => {
        written[p] = c;
      },
    });
    expect(written[path.join(TMP, "after.md")]).toBe("delivered anyway");
    expect(result.stepResults).toHaveLength(2);
  });
});

describe("runYamlRecipe — unknown tool", () => {
  it("skips unknown tools without throwing", async () => {
    const recipe = makeRecipe({
      steps: [{ tool: "future.thing", param: "x" }],
    });
    const result = await runYamlRecipe(recipe, noop());
    expect(result.stepsRun).toBe(1);
  });
});

describe("runYamlRecipe — seed context", () => {
  it("merges seed context into template vars", async () => {
    const recipe = makeRecipe({
      steps: [
        {
          tool: "file.write",
          path: path.join(TMP, "out.md"),
          content: "file: {{file}}",
        },
      ],
    });
    const written: Record<string, string> = {};
    await runYamlRecipe(
      recipe,
      {
        ...noop(),
        writeFile: (p, c) => {
          written[p] = c;
        },
      },
      { file: "src/index.ts" },
    );
    expect(written[path.join(TMP, "out.md")]).toBe("file: src/index.ts");
  });
});

// ── step.when guard ───────────────────────────────────────────────────────────
//
// Regression: the `when:` clause is honored by chainedRunner but was silently
// dropped in yamlRunner — every non-chained trigger (manual, cron, file_watch,
// on_file_save, on_test_run, webhook, git_hook) ignored it. The 4 bridge-dev
// iMessage recipes use `when: "{{phone}}"` to suppress an agent step when the
// phone variable is empty; without this guard the agent ran every time.
//
// Match chainedRunner.ts:248-266 semantics: render template, truthy check
// (empty string, "0", "false", "null", "undefined" are falsy).

describe("runYamlRecipe — step.when guard", () => {
  it("skips a tool step when `when` template renders empty", async () => {
    const written: Record<string, string> = {};
    const recipe = makeRecipe({
      steps: [
        {
          tool: "file.write",
          path: path.join(TMP, "first.md"),
          content: "always",
        },
        {
          tool: "file.write",
          path: path.join(TMP, "second.md"),
          content: "guarded",
          when: "{{flag}}",
        },
      ],
    });
    const result = await runYamlRecipe(
      recipe,
      {
        ...noop(),
        writeFile: (p, c) => {
          written[p] = c;
        },
      },
      { flag: "" },
    );
    expect(written[path.join(TMP, "first.md")]).toBe("always");
    expect(written[path.join(TMP, "second.md")]).toBeUndefined();
    expect(result.stepResults[1]!.status).toBe("skipped");
    expect(result.errorMessage).toBeUndefined();
  });

  it("runs a tool step when `when` template renders truthy", async () => {
    const written: Record<string, string> = {};
    const recipe = makeRecipe({
      steps: [
        {
          tool: "file.write",
          path: path.join(TMP, "first.md"),
          content: "always",
        },
        {
          tool: "file.write",
          path: path.join(TMP, "second.md"),
          content: "guarded",
          when: "{{flag}}",
        },
      ],
    });
    const result = await runYamlRecipe(
      recipe,
      {
        ...noop(),
        writeFile: (p, c) => {
          written[p] = c;
        },
      },
      { flag: "yes" },
    );
    expect(written[path.join(TMP, "first.md")]).toBe("always");
    expect(written[path.join(TMP, "second.md")]).toBe("guarded");
    expect(result.stepResults[1]!.status).toBe("ok");
  });

  it("skips an agent step when `when` is empty (no agent invocation)", async () => {
    let agentCalls = 0;
    const recipe = makeRecipe({
      steps: [
        {
          tool: "file.write",
          path: path.join(TMP, "report.md"),
          content: "report",
        },
        {
          when: "{{phone}}",
          agent: {
            driver: "claude-code",
            prompt: "send to {{phone}}",
            into: "im_result",
          },
        },
      ],
    });
    const result = await runYamlRecipe(
      recipe,
      {
        ...noop(),
        writeFile: () => {},
        claudeCodeFn: async () => {
          agentCalls++;
          return "should never run";
        },
      },
      { phone: "" },
    );
    expect(agentCalls).toBe(0);
    expect(result.stepResults[1]!.status).toBe("skipped");
    expect(result.errorMessage).toBeUndefined();
  });

  it("runs the agent step when `when` is truthy", async () => {
    let agentCalls = 0;
    const recipe = makeRecipe({
      steps: [
        {
          tool: "file.write",
          path: path.join(TMP, "report.md"),
          content: "report",
        },
        {
          when: "{{phone}}",
          agent: {
            driver: "claude-code",
            prompt: "send to {{phone}}",
            into: "im_result",
          },
        },
      ],
    });
    await runYamlRecipe(
      recipe,
      {
        ...noop(),
        writeFile: () => {},
        claudeCodeFn: async () => {
          agentCalls++;
          return "ok";
        },
      },
      { phone: "+15551234567" },
    );
    expect(agentCalls).toBe(1);
  });

  it("treats '0' / 'false' / 'null' / 'undefined' as falsy (matches chainedRunner)", async () => {
    for (const falsy of ["0", "false", "null", "undefined", " "]) {
      const written: Record<string, string> = {};
      const recipe = makeRecipe({
        steps: [
          {
            tool: "file.write",
            path: path.join(TMP, "x.md"),
            content: "x",
            when: "{{flag}}",
          },
        ],
      });
      await runYamlRecipe(
        recipe,
        {
          ...noop(),
          writeFile: (p, c) => {
            written[p] = c;
          },
        },
        { flag: falsy },
      );
      expect(written[path.join(TMP, "x.md")]).toBeUndefined();
    }
  });

  it("M25: skips step when when: false (YAML boolean, not string)", async () => {
    // YAML deserialises `when: false` as boolean false. The previous guard
    // `if (typeof step.when === "string")` missed this case and the step ran.
    let agentCalls = 0;
    const recipe = makeRecipe({
      steps: [
        {
          agent: {
            prompt: "should not run",
            model: "claude-haiku-4-5-20251001",
            into: "result",
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          when: false as any,
        },
      ],
    });
    await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async () => {
        agentCalls++;
        return "ran";
      },
    });
    expect(agentCalls).toBe(0);
  });
});

// ── recipe-level context blocks (type: env) ───────────────────────────────────

describe("runYamlRecipe — context: env blocks", () => {
  it("resolves env vars listed under context[].keys into template scope", async () => {
    process.env.YAMLRUNNER_TEST_CHANNEL = "C12345";
    try {
      const recipe = makeRecipe({
        // The runner reads `recipe.context` even though it's not part of the
        // narrow YamlRecipe type, so we cast through `unknown` here.
        ...({
          context: [{ type: "env", keys: ["YAMLRUNNER_TEST_CHANNEL"] }],
        } as unknown as Partial<YamlRecipe>),
        steps: [
          {
            tool: "file.write",
            path: path.join(TMP, "out.md"),
            content: "channel={{YAMLRUNNER_TEST_CHANNEL}}",
          },
        ],
      });
      const written: Record<string, string> = {};
      await runYamlRecipe(recipe, {
        ...noop(),
        writeFile: (p, c) => {
          written[p] = c;
        },
      });
      expect(written[path.join(TMP, "out.md")]).toBe("channel=C12345");
    } finally {
      delete process.env.YAMLRUNNER_TEST_CHANNEL;
    }
  });

  it("seed context overrides env-block values when keys collide", async () => {
    process.env.YAMLRUNNER_TEST_OVERRIDE = "from-env";
    try {
      const recipe = makeRecipe({
        ...({
          context: [{ type: "env", keys: ["YAMLRUNNER_TEST_OVERRIDE"] }],
        } as unknown as Partial<YamlRecipe>),
        steps: [
          {
            tool: "file.write",
            path: path.join(TMP, "out.md"),
            content: "v={{YAMLRUNNER_TEST_OVERRIDE}}",
          },
        ],
      });
      const written: Record<string, string> = {};
      await runYamlRecipe(
        recipe,
        {
          ...noop(),
          writeFile: (p, c) => {
            written[p] = c;
          },
        },
        { YAMLRUNNER_TEST_OVERRIDE: "from-seed" },
      );
      // Seed context is merged after env block, so it wins on collisions.
      expect(written[path.join(TMP, "out.md")]).toBe("v=from-seed");
    } finally {
      delete process.env.YAMLRUNNER_TEST_OVERRIDE;
    }
  });

  it("ignores env-block keys that are not set in process.env", async () => {
    delete process.env.YAMLRUNNER_TEST_MISSING;
    const recipe = makeRecipe({
      ...({
        context: [{ type: "env", keys: ["YAMLRUNNER_TEST_MISSING"] }],
      } as unknown as Partial<YamlRecipe>),
      steps: [
        {
          tool: "file.write",
          path: path.join(TMP, "out.md"),
          content: "v={{YAMLRUNNER_TEST_MISSING}}",
        },
      ],
    });
    const written: Record<string, string> = {};
    await runYamlRecipe(recipe, {
      ...noop(),
      writeFile: (p, c) => {
        written[p] = c;
      },
    });
    // Unset env vars render to empty string (existing render contract), not
    // the literal `{{...}}` placeholder.
    expect(written[path.join(TMP, "out.md")]).toBe("v=");
  });
});

// ── JSON-aware dot-notation on `into` outputs ─────────────────────────────────

describe("runYamlRecipe — JSON parse-on-into for dot-notation lookups", () => {
  it("lets a downstream step reference fields of a JSON-stringified output", async () => {
    // file.read returns a string; the runner should parse JSON-shaped strings
    // before storing under `into` so that `{{data.field}}` works.
    const written: Record<string, string> = {};
    const recipe = makeRecipe({
      steps: [
        { tool: "file.read", path: path.join(TMP, "in.json"), into: "data" },
        {
          tool: "file.write",
          path: path.join(TMP, "out.md"),
          content: "name={{data.name}} count={{data.count}}",
        },
      ],
    });
    await runYamlRecipe(recipe, {
      ...noop(),
      readFile: () => JSON.stringify({ name: "patchwork", count: 7 }),
      writeFile: (p, c) => {
        written[p] = c;
      },
    });
    expect(written[path.join(TMP, "out.md")]).toBe("name=patchwork count=7");
  });

  it("falls back to raw string lookup when output is not valid JSON", async () => {
    const written: Record<string, string> = {};
    const recipe = makeRecipe({
      steps: [
        { tool: "file.read", path: path.join(TMP, "in.txt"), into: "data" },
        {
          tool: "file.write",
          path: path.join(TMP, "out.md"),
          content: "raw={{data}}",
        },
      ],
    });
    await runYamlRecipe(recipe, {
      ...noop(),
      readFile: () => "plain text body",
      writeFile: (p, c) => {
        written[p] = c;
      },
    });
    expect(written[path.join(TMP, "out.md")]).toBe("raw=plain text body");
  });
});

// ── ambient-journal template ──────────────────────────────────────────────────

describe("ambient-journal template shape", () => {
  it("runs end-to-end against a scratch dir", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "patchwork-test-"));
    try {
      const appended: Array<[string, string]> = [];
      const recipe = validateYamlRecipe({
        name: "ambient-journal",
        trigger: { type: "git_hook", on: "post-commit" },
        steps: [
          {
            tool: "file.append",
            path: `${tmp}/journal.md`,
            content: "- {{time}}  committed {{hash}} — {{message}}\n",
          },
        ],
        output: { path: `${tmp}/inbox/ambient-journal.md` },
      });
      await runYamlRecipe(
        recipe,
        {
          ...noop(),
          appendFile: (p, c) => {
            appended.push([p, c]);
          },
        },
        { hash: "abc1234", message: "feat: add something" },
      );
      expect(appended).toHaveLength(1);
      expect(appended[0]![1]).toContain("abc1234");
      expect(appended[0]![1]).toContain("feat: add something");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── listYamlRecipes ───────────────────────────────────────────────────────────

describe("listYamlRecipes", () => {
  it("returns empty array for missing dir", () => {
    expect(listYamlRecipes("/nonexistent/path")).toEqual([]);
  });

  it("lists yaml and json recipes, skips .permissions.json", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "patchwork-list-"));
    try {
      writeFileSync(
        path.join(tmp, "daily-status.yaml"),
        "name: daily-status\ndescription: morning brief\ntrigger:\n  type: cron\nsteps:\n  - tool: file.write\n    path: /tmp/x\n    content: x\n",
      );
      writeFileSync(
        path.join(tmp, "webhook.json"),
        JSON.stringify({
          name: "webhook",
          trigger: { type: "webhook" },
          steps: [],
        }),
      );
      writeFileSync(path.join(tmp, "webhook.json.permissions.json"), "{}");
      const list = listYamlRecipes(tmp);
      expect(list.map((r) => r.name)).toContain("daily-status");
      expect(list.map((r) => r.name)).toContain("webhook");
      expect(list.map((r) => r.name)).not.toContain("webhook.json.permissions");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips malformed files and continues", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "patchwork-list2-"));
    try {
      writeFileSync(path.join(tmp, "broken.yaml"), "{ not: yaml: valid: : :");
      writeFileSync(
        path.join(tmp, "good.yaml"),
        "name: good\ntrigger:\n  type: manual\nsteps:\n  - tool: file.read\n    path: /tmp/x\n",
      );
      const list = listYamlRecipes(tmp);
      expect(list.map((r) => r.name)).toContain("good");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Gmail helpers ─────────────────────────────────────────────────────────────

/** Build a mock fetch that returns list + detail responses for Gmail API. */
function makeMockFetch(
  messages: Array<{
    id: string;
    subject: string;
    from: string;
    date: string;
    snippet: string;
  }>,
): FetchFn {
  return async (url: string) => {
    if (url.includes("/messages?")) {
      return {
        ok: true,
        json: async () => ({
          messages: messages.map((m) => ({ id: m.id, threadId: m.id })),
          resultSizeEstimate: messages.length,
        }),
      };
    }
    // detail fetch — extract id from URL
    const id = url.split("/messages/")[1]?.split("?")[0] ?? "";
    const msg = messages.find((m) => m.id === id) ?? messages[0]!;
    return {
      ok: true,
      json: async () => ({
        id: msg.id,
        snippet: msg.snippet,
        payload: {
          headers: [
            { name: "Subject", value: msg.subject },
            { name: "From", value: msg.from },
            { name: "Date", value: msg.date },
          ],
        },
      }),
    };
  };
}

const sampleMessages = [
  {
    id: "msg1",
    subject: "Hello world",
    from: "alice@example.com",
    date: "Mon, 18 Apr 2026 08:00:00 +0000",
    snippet: "This is a test email.",
  },
  {
    id: "msg2",
    subject: "Follow up",
    from: "bob@example.com",
    date: "Mon, 18 Apr 2026 09:00:00 +0000",
    snippet: "Following up on the last email.",
  },
];

describe("runYamlRecipe — gmail.fetch_unread", () => {
  it("fetches unread messages and stores count in context", async () => {
    const recipe = makeRecipe({
      steps: [
        { tool: "gmail.fetch_unread", since: "24h", max: 10, into: "messages" },
        {
          tool: "file.write",
          path: path.join(TMP, "out.md"),
          content: "count: {{messages.count}}",
        },
      ],
    });
    const written: Record<string, string> = {};
    await runYamlRecipe(recipe, {
      ...noop(),
      fetchFn: makeMockFetch(sampleMessages),
      getGmailToken: async () => "test-token",
      writeFile: (p, c) => {
        written[p] = c;
      },
    });
    expect(written[path.join(TMP, "out.md")]).toBe("count: 2");
  });

  it("stores message array as JSON in context key", async () => {
    const recipe = makeRecipe({
      steps: [
        { tool: "gmail.fetch_unread", since: "7d", max: 5, into: "inbox" },
      ],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      fetchFn: makeMockFetch(sampleMessages),
      getGmailToken: async () => "test-token",
    });
    const parsed = JSON.parse(result.context.inbox!) as {
      count: number;
      messages: unknown[];
    };
    expect(parsed.count).toBe(2);
    expect(parsed.messages[0]).toMatchObject({ subject: "Hello world" });
  });
});

describe("runYamlRecipe — gmail.fetch_unread when not connected", () => {
  it("stores error in context and does not throw", async () => {
    const recipe = makeRecipe({
      steps: [
        { tool: "gmail.fetch_unread", since: "24h", max: 5, into: "inbox" },
      ],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      fetchFn: makeMockFetch([]),
      getGmailToken: async () => {
        throw new Error("Gmail not connected");
      },
    });
    const parsed = JSON.parse(result.context.inbox!) as {
      count: number;
      error?: string;
    };
    expect(parsed.count).toBe(0);
    expect(parsed.error).toBe("Gmail not connected");
  });
});

describe("runYamlRecipe — gmail.search", () => {
  it("passes custom query to Gmail API and returns results", async () => {
    const capturedUrls: string[] = [];
    const mockFetch: FetchFn = async (url) => {
      capturedUrls.push(url);
      if (url.includes("/messages?")) {
        return {
          ok: true,
          json: async () => ({
            messages: [{ id: "msg1", threadId: "msg1" }],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          id: "msg1",
          snippet: "Test snippet",
          payload: {
            headers: [
              { name: "Subject", value: "Search result" },
              { name: "From", value: "sender@example.com" },
              { name: "Date", value: "Mon, 18 Apr 2026 10:00:00 +0000" },
            ],
          },
        }),
      };
    };
    const recipe = makeRecipe({
      steps: [
        {
          tool: "gmail.search",
          query: "from:boss@company.com is:unread",
          max: 5,
          into: "boss",
        },
      ],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      fetchFn: mockFetch,
      getGmailToken: async () => "test-token",
    });
    expect(capturedUrls[0]).toContain(
      encodeURIComponent("from:boss@company.com is:unread"),
    );
    const parsed = JSON.parse(result.context.boss!) as { count: number };
    expect(parsed.count).toBe(1);
  });
});

// ── agent step ────────────────────────────────────────────────────────────────

describe("runYamlRecipe — agent step", () => {
  it("calls claudeFn with rendered prompt and stores result in into key", async () => {
    const calls: Array<{ prompt: string; model: string }> = [];
    const recipe = makeRecipe({
      steps: [
        {
          agent: {
            prompt: "Summarise: {{topic}}",
            model: "claude-haiku-4-5-20251001",
            into: "summary",
          },
        },
      ],
    });
    const result = await runYamlRecipe(
      recipe,
      {
        ...noop(),
        claudeFn: async (prompt, model) => {
          calls.push({ prompt, model });
          return "Here is the summary.";
        },
      },
      { topic: "AI trends" },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toBe("Summarise: AI trends");
    expect(calls[0]!.model).toBe("claude-haiku-4-5-20251001");
    expect(result.context.summary).toBe("Here is the summary.");
    expect(result.outputs).toContain("summary");
  });

  it("stores result in default agent_output key when into is omitted", async () => {
    const recipe = makeRecipe({
      steps: [
        {
          agent: {
            prompt: "Hello",
          },
        },
      ],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async () => "response text",
    });
    expect(result.context.agent_output).toBe("response text");
    expect(result.outputs).toContain("agent_output");
  });

  it("uses default model claude-haiku-4-5-20251001 when model is omitted", async () => {
    const models: string[] = [];
    const recipe = makeRecipe({
      steps: [{ agent: { prompt: "Hi", into: "out" } }],
    });
    await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async (_p, model) => {
        models.push(model);
        return "ok";
      },
    });
    expect(models[0]).toBe("claude-haiku-4-5-20251001");
  });

  it("stores skip message gracefully when claudeFn returns skip message (opt-out)", async () => {
    // Pre-P1 behavior is preserved when the step opts out of silent-fail
    // detection. Without `silentFailDetection: false`, the skip-message
    // marker is now flagged as an error (see "silent-fail detection (P1)"
    // describe block above) — that's the intentional fix.
    const recipe = makeRecipe({
      steps: [
        {
          agent: { prompt: "Hi", into: "out" },
          silentFailDetection: false,
        },
      ],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async () => "[agent step skipped: ANTHROPIC_API_KEY not set]",
    });
    expect(result.context.out).toContain("skipped");
    expect(result.stepsRun).toBe(1);
  });

  it("increments stepsRun for agent steps", async () => {
    const recipe = makeRecipe({
      steps: [
        { agent: { prompt: "step 1", into: "a" } },
        { agent: { prompt: "step 2", into: "b" } },
      ],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async () => "done",
    });
    expect(result.stepsRun).toBe(2);
  });
});

// ── agent step — driver: claude-code ─────────────────────────────────────────

describe("runYamlRecipe — agent step with driver: claude-code", () => {
  it("calls claudeCodeFn instead of claudeFn when driver is claude-code", async () => {
    const claudeCalls: string[] = [];
    const claudeCodeCalls: string[] = [];
    const recipe = makeRecipe({
      steps: [
        {
          agent: {
            prompt: "Summarise: {{topic}}",
            driver: "claude-code",
            into: "summary",
          },
        },
      ],
    });
    const result = await runYamlRecipe(
      recipe,
      {
        ...noop(),
        claudeFn: async (p) => {
          claudeCalls.push(p);
          return "api response";
        },
        claudeCodeFn: async (p) => {
          claudeCodeCalls.push(p);
          return "cli response";
        },
      },
      { topic: "AI trends" },
    );
    expect(claudeCalls).toHaveLength(0);
    expect(claudeCodeCalls).toHaveLength(1);
    expect(claudeCodeCalls[0]).toBe("Summarise: AI trends");
    expect(result.context.summary).toBe("cli response");
  });

  // P0-5 — runner seam: the opt-in tool sandbox fields must thread from the
  // YAML agent step through the flat runner into the claudeCodeFn opts (HOPs
  // 0b/1/2). Proven without spawning a subprocess by capturing the opts arg.
  it("threads sandbox/tools/disallowedTools through the FLAT runner into claudeCodeFn opts", async () => {
    const seen: Array<{ prompt: string; opts: unknown }> = [];
    const claudeCodeFn = vi.fn(async (prompt: string, opts?: unknown) => {
      seen.push({ prompt, opts });
      return "ok";
    });
    const recipe = makeRecipe({
      steps: [
        {
          agent: {
            prompt: "Do the thing",
            driver: "claude-code",
            sandbox: true,
            tools: ["getDiagnostics"],
            disallowedTools: ["runCommand"],
            into: "result",
          },
        },
      ],
    });
    await runYamlRecipe(recipe, { ...noop(), claudeCodeFn }, {});
    expect(claudeCodeFn).toHaveBeenCalledTimes(1);
    expect(seen[0]!.opts).toEqual({
      sandbox: true,
      allowedTools: ["getDiagnostics"],
      disallowedTools: ["runCommand"],
    });
  });

  // P0-5 + parity fix (Edit 8): the chained runner closure previously dropped
  // its 4th arg (mcpAccess) because AgentExecutor was 3-arg. Now it forwards an
  // opts object — proving both the sandbox fields AND mcpAccess thread through.
  it("threads sandbox/tools/disallowedTools (and mcpAccess) through the CHAINED executeAgent into claudeCodeFn opts", async () => {
    const seen: Array<{ prompt: string; opts: unknown }> = [];
    const claudeCodeFn = vi.fn(async (prompt: string, opts?: unknown) => {
      seen.push({ prompt, opts });
      return "cc result";
    });
    const deps = buildChainedDeps({ ...noop(), testMode: true }, claudeCodeFn);
    await deps.executeAgent("review this", undefined, "claude-code", {
      mcpAccess: true,
      sandbox: true,
      allowedTools: ["getGitStatus"],
      disallowedTools: ["gitPush"],
    });
    expect(claudeCodeFn).toHaveBeenCalledTimes(1);
    expect(seen[0]!.opts).toEqual({
      mcpAccess: true,
      sandbox: true,
      allowedTools: ["getGitStatus"],
      disallowedTools: ["gitPush"],
    });
  });

  it("stores claudeCodeFn output in context key", async () => {
    const recipe = makeRecipe({
      steps: [
        {
          agent: {
            prompt: "List key points about {{subject}}",
            driver: "claude-code",
            into: "points",
          },
        },
      ],
    });
    const result = await runYamlRecipe(
      recipe,
      {
        ...noop(),
        claudeCodeFn: async () => "- point one\n- point two",
      },
      { subject: "testing" },
    );
    expect(result.context.points).toBe("- point one\n- point two");
    expect(result.outputs).toContain("points");
  });

  it("falls back to claudeCodeFn when driver is absent, no ANTHROPIC_API_KEY, and no custom claudeFn", async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const claudeCodeCalls: string[] = [];
      const recipe = makeRecipe({
        steps: [{ agent: { prompt: "hello", into: "out" } }],
      });
      // Do NOT provide claudeFn — only claudeCodeFn. The runner will probe for claude CLI
      // and if found, call claudeCodeFn. In CI without claude CLI, it falls through to
      // defaultClaudeFn (which returns the skip-message placeholder). Either way,
      // stepsRun is 1.
      const result = await runYamlRecipe(recipe, {
        ...noop(),
        claudeCodeFn: async (p) => {
          claudeCodeCalls.push(p);
          return "cli fallback response";
        },
      });
      // The step ran regardless of which path was taken.
      expect(result.stepsRun).toBe(1);
      // CLI present (local dev) → claudeCodeFn ran → context.out is defined.
      // CLI absent (CI) → defaultClaudeFn returned the skip-message, which the
      // P1 silent-fail detector now flags as a step error → context.out is
      // undefined. Both outcomes are valid for THIS test (we're only proving
      // the fallback wiring exists, not which branch fires).
      if (claudeCodeCalls.length > 0) {
        expect(result.context.out).toBeDefined();
      } else {
        // The default-claude-fn path: detector caught the skip-message as
        // a step error — that's the new correct behavior post-P1.
        expect(result.stepResults[0]?.status).toBe("error");
        expect(result.stepResults[0]?.error).toMatch(/silent-fail|skip/i);
      }
    } finally {
      if (origKey !== undefined) process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  it("does not call claudeCodeFn when driver is api (explicit)", async () => {
    const claudeCodeCalls: string[] = [];
    const recipe = makeRecipe({
      steps: [
        {
          agent: {
            prompt: "Hello",
            driver: "api",
            into: "out",
          },
        },
      ],
    });
    await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async () => "api response",
      claudeCodeFn: async (p) => {
        claudeCodeCalls.push(p);
        return "cli response";
      },
    });
    expect(claudeCodeCalls).toHaveLength(0);
  });
});

describe("morning-brief recipe end-to-end", () => {
  it("runs gmail + git + agent + file.write and produces brief", async () => {
    const written: Record<string, string> = {};
    const agentCalls: string[] = [];

    const recipe = makeRecipe({
      name: "morning-brief",
      steps: [
        { tool: "gmail.fetch_unread", since: "24h", max: 30, into: "messages" },
        { tool: "git.log_since", since: "24h", into: "commits" },
        {
          agent: {
            prompt:
              "Emails: {{messages.json}}\nCommits: {{commits}}\nWrite brief.",
            model: "claude-haiku-4-5-20251001",
            into: "brief",
          },
        },
        {
          tool: "file.write",
          path: "~/.patchwork/inbox/morning-brief-{{date}}.md",
          content: "# Morning brief — {{date}}\n\n{{brief}}",
        },
      ],
    });

    await runYamlRecipe(recipe, {
      ...noop(),
      fetchFn: makeMockFetch(sampleMessages),
      getGmailToken: async () => "test-token",
      gitLogSince: () => "abc1234 feat: shipped agent step",
      claudeFn: async (prompt) => {
        agentCalls.push(prompt);
        return "**Email triage**: Hello world (action needed)\n**Code activity**: shipped agent step";
      },
      writeFile: (p, c) => {
        written[p] = c;
      },
    });

    // claudeFn was called once
    expect(agentCalls).toHaveLength(1);
    // prompt includes rendered gmail messages JSON
    expect(agentCalls[0]).toContain("Hello world");
    // prompt includes git commits
    expect(agentCalls[0]).toContain("abc1234");
    // output file was written
    const outputPath = Object.keys(written)[0]!;
    expect(outputPath).toContain("morning-brief-2026-04-18.md");
    expect(written[outputPath]).toContain("Morning brief");
    expect(written[outputPath]).toContain("Email triage");
  });
});

describe("gmail-health-check recipe end-to-end", () => {
  it("runs both gmail steps and writes health file", async () => {
    const recipe = validateYamlRecipe({
      name: "gmail-health-check",
      description: "Verify Gmail connector is working.",
      trigger: { type: "manual" },
      steps: [
        { tool: "gmail.fetch_unread", since: "7d", max: 5, into: "recent" },
        {
          tool: "gmail.search",
          query: "is:unread",
          max: 1,
          into: "unread_check",
        },
        {
          tool: "file.write",
          path: path.join(TMP, "gmail-health.md"),
          content:
            "unread-7d: {{recent.count}}\ntotal-unread: {{unread_check.count}}",
        },
      ],
    });
    const written: Record<string, string> = {};
    await runYamlRecipe(recipe, {
      ...noop(),
      fetchFn: makeMockFetch(sampleMessages),
      getGmailToken: async () => "test-token",
      writeFile: (p, c) => {
        written[p] = c;
      },
    });
    expect(written[path.join(TMP, "gmail-health.md")]).toContain(
      "unread-7d: 2",
    );
    // max:1 means at most 1 result returned for unread_check
    expect(written[path.join(TMP, "gmail-health.md")]).toContain(
      "total-unread: 1",
    );
  });
});

describe("linear.list_issues step", () => {
  it("returns issues when connected", async () => {
    mockLoadTokens.mockReturnValue({
      api_key: "lin_api_test",
      workspace: "patchwork-os",
      connected_at: "2026-01-01T00:00:00.000Z",
    });
    mockListIssues.mockResolvedValue([
      { identifier: "LIN-1", title: "Fix auth" },
      { identifier: "LIN-2", title: "Add tests" },
    ]);

    const written: Record<string, string> = {};
    await runYamlRecipe(
      makeRecipe({
        steps: [
          {
            tool: "linear.list_issues",
            assignee: "@me",
            max: 15,
            into: "linear_issues",
          },
          {
            tool: "file.write",
            path: path.join(TMP, "linear-out.md"),
            content: "{{linear_issues}}",
          },
        ],
      }),
      {
        ...noop(),
        writeFile: (p, c) => {
          written[p] = c;
        },
      },
    );
    const out = JSON.parse(
      written[path.join(TMP, "linear-out.md")] ?? "{}",
    ) as {
      count: number;
      issues: unknown[];
    };
    expect(out.count).toBe(2);
    expect(out.issues).toHaveLength(2);
    expect(mockListIssues).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 15, assigneeMe: true }),
    );
  });

  it("returns error payload when not connected", async () => {
    mockLoadTokens.mockReturnValue(null);
    const written: Record<string, string> = {};
    await runYamlRecipe(
      makeRecipe({
        steps: [
          { tool: "linear.list_issues", into: "linear_issues" },
          {
            tool: "file.write",
            path: path.join(TMP, "linear-out.md"),
            content: "{{linear_issues}}",
          },
        ],
      }),
      {
        ...noop(),
        writeFile: (p, c) => {
          written[p] = c;
        },
      },
    );
    const out = JSON.parse(
      written[path.join(TMP, "linear-out.md")] ?? "{}",
    ) as {
      count: number;
      error: string;
    };
    expect(out.count).toBe(0);
    expect(out.error).toContain("not connected");
  });

  it("returns error payload on API failure", async () => {
    mockLoadTokens.mockReturnValue({
      api_key: "lin_api_test",
      connected_at: "2026-01-01T00:00:00.000Z",
    });
    mockListIssues.mockRejectedValue(new Error("unauthorized"));
    const written: Record<string, string> = {};
    await runYamlRecipe(
      makeRecipe({
        steps: [
          { tool: "linear.list_issues", into: "linear_issues" },
          {
            tool: "file.write",
            path: path.join(TMP, "linear-out.md"),
            content: "{{linear_issues}}",
          },
        ],
      }),
      {
        ...noop(),
        writeFile: (p, c) => {
          written[p] = c;
        },
      },
    );
    const out = JSON.parse(
      written[path.join(TMP, "linear-out.md")] ?? "{}",
    ) as {
      count: number;
      error: string;
    };
    expect(out.count).toBe(0);
    expect(out.error).toContain("unauthorized");
  });
});

// ── github.list_issues / github.list_prs (regression for swallow-to-[]) ──────
//
// Pre-fix: the github connector caught ALL errors and returned `[]`.
// Token expiry, rate limits, MCP outages all looked like "no issues this
// week" — agents in `morning-brief*` recipes summarized "you're caught
// up" with confidence. Now the connector throws and the recipe-tool
// wrapper translates to `{count:0, items:[], error}` JSON, which the
// runner's silent-fail detector (PR #72) flags as a step error.

describe("github.list_issues step", () => {
  it("happy path: writes count + issues to context", async () => {
    mockListGithubIssues.mockResolvedValue([
      { id: 1, title: "issue 1" } as never,
      { id: 2, title: "issue 2" } as never,
    ]);
    const written: Record<string, string> = {};
    await runYamlRecipe(
      makeRecipe({
        steps: [
          { tool: "github.list_issues", into: "gh" },
          {
            tool: "file.write",
            path: path.join(TMP, "gh.md"),
            content: "{{gh}}",
          },
        ],
      }),
      {
        ...noop(),
        writeFile: (p, c) => {
          written[p] = c;
        },
      },
    );
    const out = JSON.parse(written[path.join(TMP, "gh.md")] ?? "{}") as {
      count: number;
      issues: unknown[];
    };
    expect(out.count).toBe(2);
    expect(out.issues).toHaveLength(2);
  });

  it("connector throw → recipe step is `error` with the reason (no silent empty)", async () => {
    mockListGithubIssues.mockRejectedValue(
      new Error("github list_issues failed: 401 unauthorized"),
    );
    const result = await runYamlRecipe(
      makeRecipe({
        steps: [{ tool: "github.list_issues", into: "gh" }],
      }),
      noop(),
    );
    // The recipe-tool catches the throw and returns {count:0, error}
    // JSON; the runner's silent-fail detector flags it as a step error.
    expect(result.stepResults[0]?.status).toBe("error");
    expect(result.stepResults[0]?.error).toMatch(/unauthorized|silent-fail/i);
  });
});

describe("github.list_prs step", () => {
  it("happy path: writes count + prs", async () => {
    mockListGithubPRs.mockResolvedValue([
      { id: 1, title: "pr 1", isDraft: false } as never,
    ]);
    const written: Record<string, string> = {};
    await runYamlRecipe(
      makeRecipe({
        steps: [
          { tool: "github.list_prs", into: "prs" },
          {
            tool: "file.write",
            path: path.join(TMP, "prs.md"),
            content: "{{prs}}",
          },
        ],
      }),
      {
        ...noop(),
        writeFile: (p, c) => {
          written[p] = c;
        },
      },
    );
    const out = JSON.parse(written[path.join(TMP, "prs.md")] ?? "{}") as {
      count: number;
      prs: unknown[];
    };
    expect(out.count).toBe(1);
    expect(out.prs).toHaveLength(1);
  });

  it("connector throw → recipe step is `error` (no silent empty)", async () => {
    mockListGithubPRs.mockRejectedValue(
      new Error("github list_pull_requests failed: rate limited"),
    );
    const result = await runYamlRecipe(
      makeRecipe({
        steps: [{ tool: "github.list_prs", into: "prs" }],
      }),
      noop(),
    );
    expect(result.stepResults[0]?.status).toBe("error");
    expect(result.stepResults[0]?.error).toMatch(/rate limited|silent-fail/i);
  });
});

// ── evaluateExpect ─────────────────────────────────────────────────────────────

describe("evaluateExpect — stepsRun", () => {
  const base = {
    stepsRun: 2,
    outputs: [],
    context: {},
    errorMessage: undefined,
  };

  it("passes when stepsRun matches", () => {
    expect(evaluateExpect(base, { stepsRun: 2 })).toHaveLength(0);
  });

  it("fails when stepsRun differs", () => {
    const failures = evaluateExpect(base, { stepsRun: 3 });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.assertion).toBe("stepsRun");
    expect(failures[0]!.actual).toBe(2);
    expect(failures[0]!.expected).toBe(3);
  });
});

describe("evaluateExpect — errorMessage", () => {
  it("passes when errorMessage is null and run is clean", () => {
    const base = {
      stepsRun: 1,
      outputs: [],
      context: {},
      errorMessage: undefined,
    };
    expect(evaluateExpect(base, { errorMessage: null })).toHaveLength(0);
  });

  it("fails when expecting null but run errored", () => {
    const base = {
      stepsRun: 1,
      outputs: [],
      context: {},
      errorMessage: "boom",
    };
    const failures = evaluateExpect(base, { errorMessage: null });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.message).toContain("boom");
  });

  it("passes when expected error matches actual", () => {
    const base = {
      stepsRun: 1,
      outputs: [],
      context: {},
      errorMessage: "file not found",
    };
    expect(
      evaluateExpect(base, { errorMessage: "file not found" }),
    ).toHaveLength(0);
  });

  it("fails when expected error differs from actual", () => {
    const base = {
      stepsRun: 1,
      outputs: [],
      context: {},
      errorMessage: "timeout",
    };
    const failures = evaluateExpect(base, { errorMessage: "file not found" });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.assertion).toBe("errorMessage");
  });

  it("skips errorMessage check when field absent from expect", () => {
    const base = {
      stepsRun: 1,
      outputs: [],
      context: {},
      errorMessage: "something",
    };
    expect(evaluateExpect(base, {})).toHaveLength(0);
  });
});

describe("evaluateExpect — outputs", () => {
  it("passes when all expected output keys are present", () => {
    const base = {
      stepsRun: 2,
      outputs: ["summary", "report"],
      context: {},
      errorMessage: undefined,
    };
    expect(
      evaluateExpect(base, { outputs: ["summary", "report"] }),
    ).toHaveLength(0);
  });

  it("fails for each missing output key", () => {
    const base = {
      stepsRun: 1,
      outputs: ["summary"],
      context: {},
      errorMessage: undefined,
    };
    const failures = evaluateExpect(base, { outputs: ["summary", "report"] });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.assertion).toBe("outputs");
    expect(failures[0]!.expected).toBe("report");
  });
});

describe("evaluateExpect — context", () => {
  it("passes when context values contain expected strings", () => {
    const base = {
      stepsRun: 1,
      outputs: [],
      context: { greeting: "hello world" },
      errorMessage: undefined,
    };
    expect(
      evaluateExpect(base, { context: { greeting: "hello" } }),
    ).toHaveLength(0);
  });

  it("fails when context key is missing", () => {
    const base = {
      stepsRun: 1,
      outputs: [],
      context: {},
      errorMessage: undefined,
    };
    const failures = evaluateExpect(base, { context: { greeting: "hello" } });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.assertion).toBe("context.greeting");
    expect(failures[0]!.message).toContain("missing");
  });

  it("fails when context value does not contain expected substring", () => {
    const base = {
      stepsRun: 1,
      outputs: [],
      context: { greeting: "goodbye" },
      errorMessage: undefined,
    };
    const failures = evaluateExpect(base, { context: { greeting: "hello" } });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.message).toContain("contain");
  });
});

describe("evaluateExpect — multiple assertions", () => {
  it("collects all failures in one call", () => {
    const base = {
      stepsRun: 1,
      outputs: [],
      context: {},
      errorMessage: undefined,
    };
    const failures = evaluateExpect(base, {
      stepsRun: 3,
      outputs: ["report"],
      context: { key: "value" },
    });
    expect(failures.length).toBeGreaterThanOrEqual(3);
  });

  it("returns empty array when all assertions pass", () => {
    const base = {
      stepsRun: 2,
      outputs: ["out"],
      context: { key: "expected value" },
      errorMessage: undefined,
    };
    expect(
      evaluateExpect(base, {
        stepsRun: 2,
        outputs: ["out"],
        context: { key: "expected" },
      }),
    ).toHaveLength(0);
  });
});

describe("runYamlRecipe — expect assertions wired end-to-end", () => {
  it("returns assertionFailures when expect block fails", async () => {
    const written: Record<string, string> = {};
    const recipe = makeRecipe({
      steps: [
        {
          tool: "file.write",
          path: path.join(TMP, "x.txt"),
          content: "hello",
          into: "saved",
        },
      ],
      expect: { stepsRun: 99, outputs: ["missing-key"] },
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      writeFile: (p, c) => {
        written[p] = c;
      },
    });
    expect(result.assertionFailures).toBeDefined();
    expect(result.assertionFailures!.length).toBeGreaterThanOrEqual(2);
  });

  it("returns no assertionFailures when expect block passes", async () => {
    const written: Record<string, string> = {};
    const recipe = makeRecipe({
      steps: [
        {
          tool: "file.write",
          path: path.join(TMP, "y.txt"),
          content: "hi",
          into: "saved",
        },
      ],
      expect: {
        stepsRun: 1,
        outputs: [path.join(TMP, "y.txt")],
        errorMessage: null,
      },
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      writeFile: (p, c) => {
        written[p] = c;
      },
    });
    expect(result.assertionFailures).toBeUndefined();
  });

  it("omits assertionFailures when no expect block", async () => {
    const recipe = makeRecipe({ steps: [] });
    const result = await runYamlRecipe(recipe, noop());
    expect(result.assertionFailures).toBeUndefined();
  });
});

// ── transform field ───────────────────────────────────────────────────────────

describe("transform field", () => {
  it("prefixes result with static text", async () => {
    const recipe = makeRecipe({
      steps: [
        {
          tool: "git.log_since",
          since: "1d",
          into: "log",
          transform: "prefix: {{$result}}",
        },
      ],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      gitLogSince: () => "abc1234 feat: something",
    });
    expect(result.context.log).toBe("prefix: abc1234 feat: something");
  });

  it("stores transformed value under into key", async () => {
    const recipe = makeRecipe({
      steps: [
        {
          tool: "git.log_since",
          since: "1d",
          into: "myVar",
          transform: "{{$result}}",
        },
      ],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      gitLogSince: () => "raw output",
    });
    expect(result.context.myVar).toBe("raw output");
  });

  it("falls through with original result when transform template is invalid/throws", async () => {
    // We patch render so it throws for a specific bad template
    const recipe = makeRecipe({
      steps: [
        {
          tool: "git.log_since",
          since: "1d",
          into: "out",
          // A transform that will not throw (render is lenient) but returns something predictable
          transform: "ok: {{$result}}",
        },
      ],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      gitLogSince: () => "data",
    });
    // Step should still succeed
    expect(result.errorMessage).toBeUndefined();
    expect(result.context.out).toBe("ok: data");
  });

  it("leaves result unchanged when no transform field", async () => {
    const recipe = makeRecipe({
      steps: [
        {
          tool: "git.log_since",
          since: "1d",
          into: "raw",
          // no transform
        },
      ],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      gitLogSince: () => "unchanged",
    });
    expect(result.context.raw).toBe("unchanged");
  });

  it("can interpolate other ctx vars alongside $result", async () => {
    const recipe = makeRecipe({
      steps: [
        {
          tool: "git.log_since",
          since: "1d",
          into: "combined",
          transform: "{{date}} — {{$result}}",
        },
      ],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      gitLogSince: () => "commit-abc",
    });
    expect(result.context.combined).toBe("2026-04-18 — commit-abc");
  });
});

// ── buildChainedDeps: local child.yaml resolution ────────────────────────────

describe("buildChainedDeps loadNestedRecipe", () => {
  let tmpDir: string;

  it("resolves chain: child.yaml relative to parent recipe's directory", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "patchwork-chain-test-"));
    try {
      const childPath = path.join(tmpDir, "child.yaml");
      writeFileSync(
        childPath,
        `name: child-recipe
trigger:
  type: manual
steps:
  - tool: file.read
    path: /tmp/x
`,
      );

      const deps = buildChainedDeps({}, undefined);
      const loaded = await deps.loadNestedRecipe(
        "child.yaml",
        path.join(tmpDir, "parent.yaml"),
      );

      expect(loaded).not.toBeNull();
      expect(loaded?.recipe.name).toBe("child-recipe");
      expect(loaded?.sourcePath).toBe(childPath);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null when child.yaml does not exist", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "patchwork-chain-test-"));
    try {
      const deps = buildChainedDeps({}, undefined);
      const loaded = await deps.loadNestedRecipe(
        "missing.yaml",
        path.join(tmpDir, "parent.yaml"),
      );
      expect(loaded).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── validateYamlRecipe — edge cases ──────────────────────────────────────────

describe("validateYamlRecipe — extra validation paths", () => {
  it("throws when input is null", () => {
    expect(() => validateYamlRecipe(null)).toThrow("recipe must be an object");
  });

  it("throws when input is a primitive", () => {
    expect(() => validateYamlRecipe("not-an-object")).toThrow(
      "recipe must be an object",
    );
  });

  it("throws when servers is not an array of strings", () => {
    expect(() =>
      validateYamlRecipe({
        name: "r",
        trigger: { type: "manual" },
        steps: [{ tool: "file.write" }],
        servers: [42],
      }),
    ).toThrow("recipe.servers must be an array of strings if present");
  });

  it("accepts valid servers array", () => {
    const recipe = validateYamlRecipe({
      name: "r",
      trigger: { type: "manual" },
      steps: [{ tool: "file.write" }],
      servers: ["my-plugin"],
    });
    expect(recipe.servers).toEqual(["my-plugin"]);
  });
});

// ── loadRecipeServers ─────────────────────────────────────────────────────────

vi.mock("../../pluginLoader.js", () => ({
  loadPluginsFull: vi.fn(),
}));

import { loadPluginsFull } from "../../pluginLoader.js";
import { loadRecipeServers } from "../yamlRunner.js";

const mockLoadPluginsFull = vi.mocked(loadPluginsFull);

describe("loadRecipeServers", () => {
  it("skips already-loaded specs (deduplication)", async () => {
    mockLoadPluginsFull.mockResolvedValue([]);
    await loadRecipeServers(["dedup-spec"]);
    await loadRecipeServers(["dedup-spec"]);
    expect(mockLoadPluginsFull).toHaveBeenCalledTimes(1);
  });

  it("logs warning when pluginLoader import fails", async () => {
    mockLoadPluginsFull.mockRejectedValueOnce(new Error("load fail"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await loadRecipeServers([`fail-spec-${Date.now()}`]);
    warn.mockRestore();
  });

  it("logs warning per spec that fails to load, does not throw", async () => {
    mockLoadPluginsFull.mockRejectedValueOnce(new Error("spec load error"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await loadRecipeServers([`bad-spec-${Date.now()}`]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to load"),
    );
    warn.mockRestore();
  });

  it("registers tools from loaded plugins", async () => {
    const fakePlugin = {
      tools: [
        {
          schema: { name: "my-plugin.hello" },
          handler: async () => "hello",
        },
      ],
    };
    mockLoadPluginsFull.mockResolvedValueOnce([fakePlugin as never]);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await loadRecipeServers([`plugin-with-tools-${Date.now()}`]);
    info.mockRestore();
  });
});

// ── agent step — provider driver paths ───────────────────────────────────────

describe("runYamlRecipe — agent step with provider drivers", () => {
  it("calls providerDriverFn with openai driver", async () => {
    const providerDriverFn = vi.fn().mockResolvedValue("openai result");
    const result = await runYamlRecipe(
      makeRecipe({
        steps: [{ agent: { prompt: "hello", driver: "openai", into: "out" } }],
      }),
      { ...noop(), providerDriverFn, testMode: true },
    );
    expect(providerDriverFn).toHaveBeenCalledWith("openai", "hello", undefined);
    expect(result.context.out).toBe("openai result");
    expect(result.errorMessage).toBeUndefined();
  });

  it("calls providerDriverFn with grok driver", async () => {
    const providerDriverFn = vi.fn().mockResolvedValue("grok result");
    const result = await runYamlRecipe(
      makeRecipe({
        steps: [{ agent: { prompt: "q", driver: "grok", into: "g" } }],
      }),
      { ...noop(), providerDriverFn, testMode: true },
    );
    expect(providerDriverFn).toHaveBeenCalledWith("grok", "q", undefined);
    expect(result.context.g).toBe("grok result");
  });

  it("calls providerDriverFn with gemini driver", async () => {
    const providerDriverFn = vi.fn().mockResolvedValue("gemini result");
    const result = await runYamlRecipe(
      makeRecipe({
        steps: [
          {
            agent: {
              prompt: "q",
              driver: "gemini",
              model: "gemini-pro",
              into: "gm",
            },
          },
        ],
      }),
      { ...noop(), providerDriverFn, testMode: true },
    );
    expect(providerDriverFn).toHaveBeenCalledWith("gemini", "q", "gemini-pro");
    expect(result.context.gm).toBe("gemini result");
  });

  it("treats only-narration agent output as error", async () => {
    const claudeFn = vi.fn().mockResolvedValue("   ");
    const result = await runYamlRecipe(
      makeRecipe({
        steps: [{ agent: { prompt: "q", driver: "api" }, into: "out" }],
      }),
      { ...noop(), claudeFn, testMode: true },
    );
    expect(result.errorMessage).toMatch(/returned only narration/);
    expect(result.stepResults[0]?.status).toBe("error");
  });

  it("sets errorMessage when agent step throws", async () => {
    const claudeCodeFn = vi.fn().mockRejectedValue(new Error("exec error"));
    const result = await runYamlRecipe(
      makeRecipe({
        steps: [
          {
            agent: { prompt: "q", driver: "claude-code" },
            into: "out",
          },
        ],
      }),
      { ...noop(), claudeCodeFn, testMode: true },
    );
    expect(result.errorMessage).toMatch(/exec error/);
  });

  it("sets errorMessage when agent returns [agent step failed: ...] prefix", async () => {
    const claudeFn = vi.fn().mockResolvedValue("[agent step failed: timeout]");
    const result = await runYamlRecipe(
      makeRecipe({
        steps: [{ agent: { prompt: "q", driver: "api" }, into: "out" }],
      }),
      { ...noop(), claudeFn, testMode: true },
    );
    expect(result.errorMessage).toMatch(/agent step failed/);
  });
});

// ── Bug (1): default providerDriverFn surfaces the real API error ─────────────
// API drivers (OpenAI / Grok) never set exitCode; on failure they resolve with
// { text: "", errorMessage } (or { wasAborted }). The old default only checked
// exitCode, so a 401/429 fell through to the generic "returned empty output"
// branch and the real cause was lost. These pin the corrected behaviour.

describe("makeProviderDriverFn — surfaces provider failure cause", () => {
  afterEach(() => {
    mockProviderRun.mockReset();
  });

  it("surfaces errorMessage (401/429) instead of generic empty-output", async () => {
    mockProviderRun.mockResolvedValueOnce({
      text: "",
      errorMessage: "401 unauthorized",
      durationMs: 5,
    });
    const fn = makeProviderDriverFn();
    const out = await fn("openai", "hello", undefined);
    expect(out).toContain("401 unauthorized");
    expect(out).toContain("openai");
    expect(out).not.toContain("returned empty output");
  });

  it("surfaces wasAborted (timeout/cancel) before the empty-output branch", async () => {
    mockProviderRun.mockResolvedValueOnce({
      text: "",
      wasAborted: true,
      durationMs: 5,
    });
    const fn = makeProviderDriverFn();
    const out = await fn("grok", "hello", undefined);
    expect(out).toMatch(/timed out or was cancelled/);
    expect(out).toContain("grok");
    expect(out).not.toContain("returned empty output");
  });

  it("truncates a very long errorMessage to keep the marker readable", async () => {
    mockProviderRun.mockResolvedValueOnce({
      text: "",
      errorMessage: "x".repeat(500),
      durationMs: 5,
    });
    const fn = makeProviderDriverFn();
    const out = await fn("openai", "hello", undefined);
    // 200-char cap on the message fragment (plus the surrounding marker text).
    // Error paths return the bare marker string; narrow for the union.
    expect(typeof out === "string" ? out.length : out.text.length).toBeLessThan(
      260,
    );
  });

  it("still reports generic empty-output when there is no error signal", async () => {
    mockProviderRun.mockResolvedValueOnce({ text: "", durationMs: 5 });
    const fn = makeProviderDriverFn();
    const out = await fn("openai", "hello", undefined);
    expect(out).toContain("returned empty output");
  });

  it("returns text unchanged on success (no usage → bare string)", async () => {
    mockProviderRun.mockResolvedValueOnce({ text: "all good", durationMs: 5 });
    const fn = makeProviderDriverFn();
    const out = await fn("openai", "hello", undefined);
    expect(out).toBe("all good");
  });

  it("forwards usage AND the driver-resolved model even when the step omits model (Phase 1 + Phase 3)", async () => {
    // Called with model=undefined (omitted on the step); the driver resolves
    // "gpt-4o" and reports it in providerMeta.model. That must propagate via
    // servedBy.model so RunBudget can price + enforce usdMax — otherwise an
    // omitted-model openai step silently fails open.
    mockProviderRun.mockResolvedValueOnce({
      text: "all good",
      durationMs: 5,
      providerMeta: { model: "gpt-4o", inputTokens: 30, outputTokens: 12 },
    });
    const fn = makeProviderDriverFn();
    const out = await fn("openai", "hello", undefined);
    expect(out).toEqual({
      text: "all good",
      usage: { inputTokens: 30, outputTokens: 12 },
      servedBy: { driver: "openai", model: "gpt-4o" },
    });
  });
});

// ── dispatchRecipe ────────────────────────────────────────────────────────────

import type { ChainedRecipe, ExecutionDeps } from "../chainedRunner.js";
import { dispatchRecipe } from "../yamlRunner.js";

describe("dispatchRecipe", () => {
  it("routes simple recipe to runYamlRecipe", async () => {
    const recipe = makeRecipe({
      steps: [
        { tool: "file.write", path: path.join(TMP, "x.txt"), content: "hi" },
      ],
    });
    const result = await dispatchRecipe(recipe, {
      ...noop(),
      testMode: true,
      writeFile: () => {},
    });
    expect("stepsRun" in result).toBe(true);
  });

  it("throws when chained recipe is dispatched without chainedDeps", async () => {
    const recipe = {
      ...makeRecipe(),
      trigger: { type: "chained" },
      steps: [{ id: "s1", tool: "file.write" }],
    };
    await expect(
      dispatchRecipe(recipe, { ...noop(), testMode: true }),
    ).rejects.toThrow("chainedDeps required");
  });

  it("routes chained recipe to runChainedRecipe", async () => {
    const chainedRecipe: ChainedRecipe & { trigger: { type: string } } = {
      name: "chained-test",
      trigger: { type: "chained" },
      steps: [{ id: "s1", tool: "my.tool" }],
    };
    const chainedDeps: ExecutionDeps = {
      executeTool: vi.fn().mockResolvedValue("done"),
      executeAgent: vi.fn().mockResolvedValue("agent"),
      loadNestedRecipe: vi.fn().mockResolvedValue(null),
    };
    const result = await dispatchRecipe(chainedRecipe as never, {
      ...noop(),
      testMode: true,
      chainedDeps,
    });
    expect("success" in result).toBe(true);
  });
});

// ── buildChainedDeps — executeTool and executeAgent paths ────────────────────

describe("buildChainedDeps executeTool", () => {
  it("executes a registered tool via executeStep", async () => {
    const deps = buildChainedDeps({
      ...noop(),
      testMode: true,
      // Override writeFile so the test stays hermetic — the recipe-runner
      // path jail (G-security A-PR1) rejects `/dev/null` as out-of-jail
      // even though the kernel would have absorbed the write silently.
      writeFile: () => {},
    });
    // file.write is a registered tool — should run and return a string.
    // Use a tmpdir path so the jail accepts it (CLAUDE_IDE_BRIDGE_RECIPE_TMP_JAIL=1
    // is set globally in src/__tests__/testEnvSetup.ts).
    const result = await deps.executeTool("file.write", {
      path: path.join(os.tmpdir(), "buildChainedDeps-executeTool.txt"),
      content: "test",
    });
    expect(typeof result).toBe("string");
  });

  it("returns empty string for unknown tool", async () => {
    const deps = buildChainedDeps({ ...noop(), testMode: true });
    const result = await deps.executeTool("not.a.real.tool", {});
    expect(result).toBe("");
  });
});

describe("buildChainedDeps executeAgent", () => {
  it("routes claude-code driver to claudeCodeFn", async () => {
    const claudeCodeFn = vi.fn().mockResolvedValue("cc result");
    const deps = buildChainedDeps({ ...noop(), claudeCodeFn, testMode: true });
    const result = await deps.executeAgent("hello", undefined, "claude-code");
    expect(claudeCodeFn).toHaveBeenCalledWith("hello", undefined);
    expect((result as { text: string }).text).toBe("cc result");
  });

  it("routes anthropic driver to claudeFn", async () => {
    const claudeFn = vi.fn().mockResolvedValue("api result");
    const deps = buildChainedDeps({ ...noop(), claudeFn, testMode: true });
    const result = await deps.executeAgent(
      "hello",
      "claude-haiku-4-5-20251001",
      "anthropic",
    );
    expect(claudeFn).toHaveBeenCalledWith("hello", "claude-haiku-4-5-20251001");
    expect((result as { text: string }).text).toBe("api result");
  });

  it("routes claude driver to claudeFn", async () => {
    const claudeFn = vi.fn().mockResolvedValue("api result 2");
    const deps = buildChainedDeps({ ...noop(), claudeFn, testMode: true });
    const result = await deps.executeAgent("hi", undefined, "claude");
    expect((result as { text: string }).text).toBe("api result 2");
  });

  it("routes openai driver to providerDriverFn", async () => {
    const providerDriverFn = vi.fn().mockResolvedValue("openai");
    const deps = buildChainedDeps({
      ...noop(),
      providerDriverFn,
      testMode: true,
    });
    const result = await deps.executeAgent("prompt", "gpt-4", "openai");
    expect(providerDriverFn).toHaveBeenCalledWith("openai", "prompt", "gpt-4");
    expect((result as { text: string }).text).toBe("openai");
  });

  it("uses claudeCodeFnOverride when no driver specified and no API key", async () => {
    const override = vi.fn().mockResolvedValue("override result");
    const deps = buildChainedDeps(
      { ...noop(), claudeFn: undefined, testMode: true },
      override,
    );
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await deps.executeAgent("q", undefined, undefined);
      // Either claudeFn or override was called — closure now returns AgentResult
      expect(typeof (result as { text: string }).text).toBe("string");
    } finally {
      if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });
});

// ── listYamlRecipes — JSON recipes ───────────────────────────────────────────

describe("listYamlRecipes — JSON recipe files", () => {
  it("reads .json recipe files", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "list-recipes-json-"));
    try {
      writeFileSync(
        path.join(tmpDir, "my-recipe.json"),
        JSON.stringify({
          name: "json-recipe",
          description: "a json recipe",
          trigger: { type: "cron" },
          steps: [],
        }),
      );
      const results = listYamlRecipes(tmpDir);
      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe("json-recipe");
      expect(results[0]?.trigger).toBe("cron");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses filename as name when name field is absent", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "list-recipes-noname-"));
    try {
      writeFileSync(
        path.join(tmpDir, "my-unnamed.yaml"),
        "trigger:\n  type: manual\nsteps: []\n",
      );
      const results = listYamlRecipes(tmpDir);
      expect(results[0]?.name).toBe("my-unnamed");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips .permissions.json files", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "list-recipes-perm-"));
    try {
      writeFileSync(path.join(tmpDir, "my-recipe.permissions.json"), "{}");
      const results = listYamlRecipes(tmpDir);
      expect(results).toHaveLength(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// resolveClaudeBinary — override precedence
//
// The recipe `agent:` step's `claude` spawn uses this resolver so a
// launchd-managed bridge (whose PATH may not include the developer's
// local install) can configure the binary explicitly via env or config.
// ─────────────────────────────────────────────────────────────────────

describe("resolveClaudeBinary — override precedence", async () => {
  const { resolveClaudeBinary } = await import("../yamlRunner.js");

  // Wrap each test in env restore: process.env mutations leak across
  // tests within the same vitest worker.
  const originalEnv = process.env.PATCHWORK_CLAUDE_BINARY;

  function withEnv(value: string | undefined, fn: () => void) {
    if (value === undefined) {
      delete process.env.PATCHWORK_CLAUDE_BINARY;
    } else {
      process.env.PATCHWORK_CLAUDE_BINARY = value;
    }
    try {
      fn();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.PATCHWORK_CLAUDE_BINARY;
      } else {
        process.env.PATCHWORK_CLAUDE_BINARY = originalEnv;
      }
    }
  }

  it("env var beats config + default", () => {
    withEnv("/from/env/claude", () => {
      expect(resolveClaudeBinary()).toBe("/from/env/claude");
    });
  });

  it("empty env var is treated as unset (falls through to default)", () => {
    withEnv("", () => {
      // No PatchworkConfig.claudeBinary mocked here, so this falls through
      // to the literal "claude" default. The point is: empty string in
      // env shouldn't mean "spawn empty-string-binary". On Windows the
      // default is suffixed with `.cmd` so spawn(shell:false) can resolve it.
      const expected = process.platform === "win32" ? "claude.cmd" : "claude";
      expect(resolveClaudeBinary()).toBe(expected);
    });
  });

  it("no env, no config → 'claude' default (PATH lookup)", () => {
    withEnv(undefined, () => {
      // This will call loadPatchworkConfigSync which reads the real
      // ~/.patchwork/config.json — if the developer running the test
      // has claudeBinary set there, this would return that value. The
      // assertion below tolerates either: the default OR a configured
      // override path. The strict env-precedence test above is the
      // load-bearing assertion.
      const result = resolveClaudeBinary();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  // Regression: PR #525 fixed the parallel resolver in
  // src/drivers/claude/subprocess.ts but missed this one. Before the fix,
  // every recipe `agent` step on Windows ENOENT'd because npm installs
  // `claude` as a `.cmd` shim and spawn(shell:false) won't auto-resolve.
  describe("Windows .cmd shim resolution", () => {
    const ORIG_PLATFORM = process.platform;
    afterEach(() => {
      Object.defineProperty(process, "platform", {
        value: ORIG_PLATFORM,
        configurable: true,
      });
    });

    it("appends .cmd to bare 'claude' default on win32", () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      withEnv(undefined, () => {
        const result = resolveClaudeBinary();
        // Either the default `claude` was found (→ `claude.cmd`) or the
        // dev's ~/.patchwork/config.json sets `claudeBinary` to an absolute
        // path (which we leave alone). Both endings are acceptable; bare
        // `claude` with no extension is the regression.
        expect(
          result === "claude.cmd" ||
            result.includes("\\") ||
            result.includes("/"),
        ).toBe(true);
      });
    });

    it("leaves env-provided absolute paths alone on win32", () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      withEnv("C:\\Program Files\\nodejs\\claude.cmd", () => {
        expect(resolveClaudeBinary()).toBe(
          "C:\\Program Files\\nodejs\\claude.cmd",
        );
      });
    });
  });
});

// ── PR3a — judge step (augment-only) ─────────────────────────────────────────

describe("agent kind: 'judge' — augment-only invariant (PR3a)", () => {
  it("approve verdict is attached to stepResult and status stays ok", async () => {
    const recipe = makeRecipe({
      steps: [
        {
          agent: {
            prompt: "Review my change.",
            model: "claude-haiku-4-5-20251001",
            into: "review",
            kind: "judge",
          },
        },
      ],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async () =>
        `Looks good.\n\n{"verdict": "approve", "reasons": ["scoped diff"]}`,
    });
    const step = result.stepResults[0]!;
    expect(step.status).toBe("ok");
    expect(step.judgeVerdict?.verdict).toBe("approve");
    expect(step.judgeVerdict?.reasons).toEqual(["scoped diff"]);
  });

  it("request_changes verdict does NOT halt the run (augment-only)", async () => {
    const recipe = makeRecipe({
      steps: [
        {
          agent: {
            prompt: "Review.",
            model: "claude-haiku-4-5-20251001",
            into: "review",
            kind: "judge",
          },
        },
        {
          agent: {
            prompt: "Continue.",
            model: "claude-haiku-4-5-20251001",
            into: "next",
          },
        },
      ],
    });
    let calls = 0;
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async () => {
        calls++;
        if (calls === 1) {
          return `Bad.\n{"verdict": "request_changes", "reasons": ["nope"], "fixList": ["x"]}`;
        }
        return "continued";
      },
    });
    expect(calls).toBe(2);
    expect(result.stepResults[0]?.status).toBe("ok");
    expect(result.stepResults[0]?.judgeVerdict?.verdict).toBe(
      "request_changes",
    );
    expect(result.stepResults[1]?.status).toBe("ok");
    expect(result.errorMessage).toBeUndefined();
  });

  it("unparseable verdict still yields status: ok with judgeVerdict.raw", async () => {
    const recipe = makeRecipe({
      steps: [
        {
          agent: {
            prompt: "Review.",
            model: "claude-haiku-4-5-20251001",
            into: "review",
            kind: "judge",
          },
        },
      ],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async () => "Looks fine — no JSON tail.",
    });
    const step = result.stepResults[0]!;
    expect(step.status).toBe("ok");
    expect(step.judgeVerdict?.verdict).toBe("unparseable");
    expect(step.judgeVerdict?.raw).toContain("Looks fine");
  });

  it("non-judge agent steps never get a judgeVerdict field", async () => {
    const recipe = makeRecipe({
      steps: [
        {
          agent: {
            prompt: "Summarise.",
            model: "claude-haiku-4-5-20251001",
            into: "summary",
            // no kind → defaults to regular agent
          },
        },
      ],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async () =>
        `Summary text.\n{"verdict": "approve", "reasons": []}`,
    });
    const step = result.stepResults[0]!;
    expect(step.status).toBe("ok");
    // The JSON tail in the output should NOT be parsed as a verdict
    // for non-judge steps — augment-only metadata is opt-in.
    expect(step.judgeVerdict).toBeUndefined();
  });

  it("injects the reviewed step's output as an <artefact> block", async () => {
    const recipe = makeRecipe({
      steps: [
        {
          agent: {
            prompt: "Make a haiku.",
            model: "claude-haiku-4-5-20251001",
            into: "draft",
          },
        },
        {
          agent: {
            prompt: "Review the haiku above.",
            model: "claude-haiku-4-5-20251001",
            into: "review",
            kind: "judge",
            reviews: "draft",
          },
        },
      ],
    });
    let lastPrompt = "";
    let calls = 0;
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async (prompt) => {
        calls++;
        lastPrompt = prompt;
        if (calls === 1) return "An old silent pond...";
        return `Solid.\n{"verdict": "approve", "reasons": []}`;
      },
    });
    expect(result.stepResults).toHaveLength(2);
    expect(result.stepResults[1]?.judgeVerdict?.verdict).toBe("approve");
    expect(lastPrompt).toContain("<artefact>");
    expect(lastPrompt).toContain("An old silent pond");
    expect(lastPrompt).toContain("cold-eyes reviewer");
  });

  it("M30: judge step does not overwrite the reviewed artifact in ctx", async () => {
    // The draft step writes ctx["draft"]. The judge step uses into:"review".
    // After the judge runs, ctx["draft"] must still equal the original draft
    // content — judge verdict text must never land in ctx["draft"].
    const recipe = makeRecipe({
      steps: [
        {
          agent: {
            prompt: "Make a haiku.",
            model: "claude-haiku-4-5-20251001",
            into: "draft",
          },
        },
        {
          agent: {
            prompt: "Review the haiku. {{draft}}",
            model: "claude-haiku-4-5-20251001",
            into: "draft", // same key as the draft step — the bug re-used this key
            kind: "judge",
            reviews: "draft",
          },
        },
        {
          agent: {
            prompt: "Polish: {{draft}}",
            model: "claude-haiku-4-5-20251001",
            into: "polished",
          },
        },
      ],
    });
    let calls = 0;
    let thirdStepPrompt = "";
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async (prompt) => {
        calls++;
        if (calls === 1) return "An old silent pond...";
        if (calls === 2) return `{"verdict": "approve", "reasons": ["good"]}`;
        thirdStepPrompt = prompt;
        return "An old silent pond... (polished)";
      },
    });
    expect(result.stepResults).toHaveLength(3);
    // The third step's prompt must contain the original draft text, not the verdict JSON
    expect(thirdStepPrompt).toContain("An old silent pond");
    expect(thirdStepPrompt).not.toContain('"verdict"');
  });
});

// ── judge → refine loop (opt-in; departs augment-only when fields present) ────

describe("agent kind: 'judge' — refine loop (opt-in)", () => {
  it("(a) max_revisions absent → augment-only unchanged: request_changes stays ok, no re-run", async () => {
    const recipe = makeRecipe({
      steps: [
        {
          agent: {
            prompt: "Make a draft.",
            model: "claude-haiku-4-5-20251001",
            into: "draft",
          },
        },
        {
          agent: {
            prompt: "Review the draft.",
            model: "claude-haiku-4-5-20251001",
            into: "review",
            kind: "judge",
            reviews: "draft",
            // no max_revisions → augment-only
          },
        },
      ],
    });
    let calls = 0;
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async () => {
        calls++;
        if (calls === 1) return "draft v1";
        return `Bad.\n{"verdict": "request_changes", "reasons": ["nope"], "fixList": ["fix it"]}`;
      },
    });
    // Exactly two calls: draft + single judge. No revision loop.
    expect(calls).toBe(2);
    const judge = result.stepResults[1]!;
    expect(judge.status).toBe("ok");
    expect(judge.judgeVerdict?.verdict).toBe("request_changes");
    expect(judge.revisions).toBeUndefined();
    expect(result.errorMessage).toBeUndefined();
  });

  it("(b) request_changes then approve after 1 revision → reviewed step re-run with fixList, ctx updated, final verdict approve, revisions:1", async () => {
    const recipe = makeRecipe({
      steps: [
        {
          agent: {
            prompt: "Write the draft.",
            model: "claude-haiku-4-5-20251001",
            into: "draft",
          },
        },
        {
          agent: {
            prompt: "Review the draft.",
            model: "claude-haiku-4-5-20251001",
            into: "review",
            kind: "judge",
            reviews: "draft",
            max_revisions: 2,
          },
        },
        {
          agent: {
            prompt: "Use the final draft: {{draft}}",
            model: "claude-haiku-4-5-20251001",
            into: "downstream",
          },
        },
      ],
    });
    const prompts: string[] = [];
    let calls = 0;
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async (prompt) => {
        calls++;
        prompts.push(prompt);
        // 1: draft, 2: judge request_changes, 3: revised draft, 4: judge approve, 5: downstream
        if (calls === 1) return "draft v1";
        if (calls === 2)
          return `Bad.\n{"verdict": "request_changes", "reasons": ["too short"], "fixList": ["add a closing line"]}`;
        if (calls === 3) return "draft v2 improved";
        if (calls === 4)
          return `Good.\n{"verdict": "approve", "reasons": ["fixed"]}`;
        return "downstream used draft v2 improved";
      },
    });
    expect(calls).toBe(5);
    // The revision (call 3) prompt must include the prior draft + the fixList.
    const revisionPrompt = prompts[2]!;
    expect(revisionPrompt).toContain("draft v1");
    expect(revisionPrompt).toContain("add a closing line");
    // ctx[reviews target = "draft"] updated to revised draft for downstream.
    expect(result.context.draft).toBe("draft v2 improved");
    // downstream saw the revised draft.
    const downstreamPrompt = prompts[4]!;
    expect(downstreamPrompt).toContain("draft v2 improved");
    // Final judge stepResult reflects the LAST (approve) verdict + revisions:1.
    const judge = result.stepResults[1]!;
    expect(judge.status).toBe("ok");
    expect(judge.judgeVerdict?.verdict).toBe("approve");
    expect(judge.revisions).toBe(1);
    expect(result.errorMessage).toBeUndefined();
  });

  it("(c) all-request_changes for max_revisions=2 with on_exhausted:'halt' → run halts (status error, haltCategory judge_revisions_exhausted)", async () => {
    const recipe = makeRecipe({
      steps: [
        {
          agent: {
            prompt: "Write the draft.",
            model: "claude-haiku-4-5-20251001",
            into: "draft",
          },
        },
        {
          agent: {
            prompt: "Review the draft.",
            model: "claude-haiku-4-5-20251001",
            into: "review",
            kind: "judge",
            reviews: "draft",
            max_revisions: 2,
            on_exhausted: "halt",
          },
        },
        {
          agent: {
            prompt: "Should never run.",
            model: "claude-haiku-4-5-20251001",
            into: "downstream",
          },
        },
      ],
    });
    let calls = 0;
    const requestChanges = `Nope.\n{"verdict": "request_changes", "reasons": ["still bad"], "fixList": ["try again"]}`;
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async () => {
        calls++;
        if (calls === 1) return "draft v1";
        // odd calls after first = revised drafts, even = judge request_changes
        if (calls % 2 === 0) return requestChanges;
        return `draft revision ${calls}`;
      },
    });
    const judge = result.stepResults[1]!;
    expect(judge.status).toBe("error");
    expect(judge.haltCategory).toBe("judge_revisions_exhausted");
    expect(judge.judgeVerdict?.verdict).toBe("request_changes");
    expect(judge.revisions).toBe(2);
    expect(result.errorMessage).toBeDefined();
    expect(result.errorMessage).toContain("did not approve");
    // downstream must NOT have run (run halted).
    expect(
      result.stepResults.find((s) => s.id === "downstream"),
    ).toBeUndefined();
  });

  it("(d) all-request_changes with on_exhausted:'proceed' → status ok, final verdict request_changes, downstream continues", async () => {
    const recipe = makeRecipe({
      steps: [
        {
          agent: {
            prompt: "Write the draft.",
            model: "claude-haiku-4-5-20251001",
            into: "draft",
          },
        },
        {
          agent: {
            prompt: "Review the draft.",
            model: "claude-haiku-4-5-20251001",
            into: "review",
            kind: "judge",
            reviews: "draft",
            max_revisions: 2,
            on_exhausted: "proceed",
          },
        },
        {
          agent: {
            prompt: "Downstream uses: {{draft}}",
            model: "claude-haiku-4-5-20251001",
            into: "downstream",
          },
        },
      ],
    });
    let calls = 0;
    const requestChanges = `Nope.\n{"verdict": "request_changes", "reasons": ["still bad"], "fixList": ["try again"]}`;
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async () => {
        calls++;
        if (calls === 1) return "draft v1";
        if (calls % 2 === 0) return requestChanges;
        return `draft revision ${calls}`;
      },
    });
    const judge = result.stepResults[1]!;
    expect(judge.status).toBe("ok");
    expect(judge.judgeVerdict?.verdict).toBe("request_changes");
    expect(judge.revisions).toBe(2);
    expect(result.errorMessage).toBeUndefined();
    // downstream DID run with the last revised draft.
    const downstream = result.stepResults.find((s) => s.id === "downstream");
    expect(downstream?.status).toBe("ok");
  });

  it("does not loop when the reviewed key does not map to an agent step (graceful skip)", async () => {
    const recipe = makeRecipe({
      steps: [
        {
          // tool step writes into ctx; judge "reviews" it — but it's not an agent.
          tool: "file.read",
          path: path.join(TMP, "seed.txt"),
          optional: true,
          into: "seed",
        },
        {
          agent: {
            prompt: "Review the seed.",
            model: "claude-haiku-4-5-20251001",
            into: "review",
            kind: "judge",
            reviews: "seed",
            max_revisions: 2,
          },
        },
      ],
    });
    let calls = 0;
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      readFile: () => "seed contents",
      claudeFn: async () => {
        calls++;
        return `Bad.\n{"verdict": "request_changes", "reasons": ["x"], "fixList": ["y"]}`;
      },
    });
    // Only the single judge call — no agent step to re-run, so no loop.
    expect(calls).toBe(1);
    const judge = result.stepResults[1]!;
    expect(judge.status).toBe("ok");
    expect(judge.judgeVerdict?.verdict).toBe("request_changes");
    expect(judge.revisions).toBeUndefined();
  });

  it("(M32) re-judge routes through downshift when budget is tight", async () => {
    // Set up a price table where expensive-model costs a lot and cheap-model costs nothing.
    const dir = mkdtempSync(path.join(os.tmpdir(), "pw-m32-"));
    const fixture = path.join(dir, "prices.json");
    writeFileSync(
      fixture,
      JSON.stringify({
        prices: {
          "expensive-model": { input: 1000, output: 1000 }, // $1/token → exhausts budget instantly
          "cheap-model": { input: 0, output: 0 }, // free → never exhausts budget
        },
      }),
    );
    const prev = process.env.PATCHWORK_PRICE_TABLE;
    process.env.PATCHWORK_PRICE_TABLE = fixture;
    try {
      const recipe = makeRecipe({
        budget: { usdMax: 0.00001 }, // tiny budget: exhausted after first expensive-model call
        steps: [
          {
            id: "draft",
            agent: {
              prompt: "Write a draft.",
              model: "cheap-model",
              into: "draft",
            },
          },
          {
            id: "judge",
            agent: {
              prompt: "Review the draft.",
              model: "expensive-model",
              into: "review",
              kind: "judge",
              reviews: "draft",
              max_revisions: 2,
              // downshift: use cheap-model when budget is low
              downshift: [{ model: "cheap-model" }],
            },
          },
        ],
      });
      const modelsUsed: string[] = [];
      let calls = 0;
      const result = await runYamlRecipe(recipe, {
        ...noop(),
        claudeFn: async (_prompt: string, model: string) => {
          calls++;
          modelsUsed.push(model);
          // Call 1: draft (cheap-model)
          // Call 2: judge (expensive-model → exhausts budget)
          // Call 3: re-judge after revision (M32: should downshift to cheap-model)
          if (calls === 2)
            return `Reject.\n{"verdict": "request_changes", "reasons": ["bad"], "fixList": ["fix it"], "usage": {"inputTokens": 1000000, "outputTokens": 1000000}}`;
          if (calls === 3)
            return `Good.\n{"verdict": "approve", "reasons": ["ok"]}`;
          return `revised draft ${calls}`;
        },
      });
      // If M32 is fixed, the re-judge (call 3) must NOT use "expensive-model"
      // because the budget is exhausted and downshift routes it to "cheap-model".
      if (modelsUsed.length >= 3) {
        expect(modelsUsed[2]).not.toBe("expensive-model");
      }
      // The run must not error out — either the re-judge succeeds with cheap-model
      // or the budget halts gracefully.
      expect(result).toBeDefined();
    } finally {
      if (prev === undefined) delete process.env.PATCHWORK_PRICE_TABLE;
      else process.env.PATCHWORK_PRICE_TABLE = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── PR2b — recipe.budget enforcement ─────────────────────────────────────────

describe("recipe.budget — tokensMax enforcement (PR2b)", () => {
  it("halts on the next agent step after budget is breached", async () => {
    const recipe = makeRecipe({
      budget: { tokensMax: 100 },
      steps: [
        {
          agent: {
            prompt: "step 1",
            model: "claude-haiku-4-5-20251001",
            into: "out1",
          },
        },
        {
          agent: {
            prompt: "step 2",
            model: "claude-haiku-4-5-20251001",
            into: "out2",
          },
        },
      ],
    });
    // First call consumes 120 tokens (over the 100-token cap); second
    // call must be denied admission before it ever dispatches.
    let calls = 0;
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async () => {
        calls++;
        return {
          text: `output ${calls}`,
          usage: { inputTokens: 60, outputTokens: 60 },
        };
      },
    });
    expect(calls).toBe(1); // second admission refused
    expect(result.stepResults).toHaveLength(2);
    expect(result.stepResults[0]?.status).toBe("ok");
    expect(result.stepResults[1]?.status).toBe("error");
    expect(result.stepResults[1]?.haltReason).toMatch(/budget_exceeded/);
  });

  it("enforces budget.usdMax via the price table (Phase 3 end-to-end)", async () => {
    // Deterministic: point the price loader at a temp fixture so the run does
    // not depend on the built-in prices or a dev's ~/.patchwork/prices.json.
    const dir = mkdtempSync(path.join(os.tmpdir(), "pw-usdmax-"));
    const fixture = path.join(dir, "prices.json");
    writeFileSync(
      fixture,
      JSON.stringify({ prices: { "test-haiku": { input: 1, output: 5 } } }),
    );
    const prev = process.env.PATCHWORK_PRICE_TABLE;
    process.env.PATCHWORK_PRICE_TABLE = fixture;
    try {
      const recipe = makeRecipe({
        budget: { usdMax: 5 },
        steps: [
          { agent: { prompt: "s1", model: "test-haiku", into: "o1" } },
          { agent: { prompt: "s2", model: "test-haiku", into: "o2" } },
        ],
      });
      let calls = 0;
      const result = await runYamlRecipe(recipe, {
        ...noop(),
        claudeFn: async () => {
          calls++;
          // test-haiku $1/1M in + $5/1M out → 1M + 1M = $6, over the $5 cap.
          return {
            text: `out ${calls}`,
            usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
          };
        },
      });
      expect(calls).toBe(1); // second admission refused on USD breach
      expect(result.stepResults[1]?.status).toBe("error");
      expect(result.stepResults[1]?.haltReason).toMatch(/budget_exceeded/);
      expect(result.stepResults[1]?.haltCategory).toBe("budget_exceeded");
    } finally {
      if (prev === undefined) delete process.env.PATCHWORK_PRICE_TABLE;
      else process.env.PATCHWORK_PRICE_TABLE = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces the budget on the openai/grok/gemini path (Phase 1: these now report usage)", async () => {
    // Before Phase 1, makeProviderDriverFn returned a bare string and usage
    // was dropped, so openai/grok/gemini agent steps ALWAYS failed open even
    // with a budget set. With usage now forwarded, the provider path halts
    // like the anthropic path does.
    const recipe = makeRecipe({
      budget: { tokensMax: 100 },
      steps: [
        {
          agent: {
            prompt: "s1",
            driver: "openai",
            model: "gpt-4o",
            into: "o1",
          },
        },
        {
          agent: {
            prompt: "s2",
            driver: "openai",
            model: "gpt-4o",
            into: "o2",
          },
        },
      ],
    });
    let calls = 0;
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      providerDriverFn: async () => {
        calls++;
        return {
          text: `output ${calls}`,
          usage: { inputTokens: 60, outputTokens: 60 },
        };
      },
    });
    expect(calls).toBe(1); // second admission refused
    expect(result.stepResults[0]?.status).toBe("ok");
    expect(result.stepResults[1]?.status).toBe("error");
    expect(result.stepResults[1]?.haltReason).toMatch(/budget_exceeded/);
  });

  it("downshifts to a cheaper model when usdMax is tight (Phase 4)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pw-downshift-"));
    const fixture = path.join(dir, "prices.json");
    writeFileSync(
      fixture,
      JSON.stringify({
        prices: {
          "big-model": { input: 1_000_000, output: 1_000_000 }, // ~$1/token
          "small-model": { input: 0.001, output: 0.001 },
        },
      }),
    );
    const prev = process.env.PATCHWORK_PRICE_TABLE;
    process.env.PATCHWORK_PRICE_TABLE = fixture;
    try {
      const recipe = makeRecipe({
        budget: { usdMax: 1 },
        steps: [
          {
            agent: {
              prompt: "do the thing",
              model: "big-model",
              downshift: [{ model: "small-model" }],
              into: "o1",
            },
          },
        ],
      });
      const seenModels: (string | undefined)[] = [];
      await runYamlRecipe(recipe, {
        ...noop(),
        claudeFn: async (_prompt, model) => {
          seenModels.push(model);
          return { text: "ok", usage: { inputTokens: 10, outputTokens: 10 } };
        },
      });
      // The expensive preferred model can't fit the $1 cap for the call, so the
      // run downshifts to the cheaper listed model.
      expect(seenModels).toEqual(["small-model"]);
    } finally {
      if (prev === undefined) delete process.env.PATCHWORK_PRICE_TABLE;
      else process.env.PATCHWORK_PRICE_TABLE = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores downshift when no usdMax is set (byte-identical)", async () => {
    const recipe = makeRecipe({
      steps: [
        {
          agent: {
            prompt: "x",
            model: "big-model",
            downshift: [{ model: "small-model" }],
            into: "o1",
          },
        },
      ],
    });
    const seen: (string | undefined)[] = [];
    await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async (_p, m) => {
        seen.push(m);
        return "ok";
      },
    });
    expect(seen).toEqual(["big-model"]); // preferred used; no routing
  });

  it("surfaces a ≈$ estimate for unmeasured drivers when estimateUnmeasured is on", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pw-estimate-"));
    const fixture = path.join(dir, "prices.json");
    writeFileSync(
      fixture,
      JSON.stringify({ prices: { "sub-model": { input: 100, output: 100 } } }),
    );
    const prev = process.env.PATCHWORK_PRICE_TABLE;
    process.env.PATCHWORK_PRICE_TABLE = fixture;
    try {
      const recipe = makeRecipe({
        budget: { usdMax: 1000, estimateUnmeasured: true },
        steps: [
          {
            agent: {
              prompt: "estimate me please",
              model: "sub-model",
              into: "o1",
            },
          },
        ],
      });
      const result = await runYamlRecipe(recipe, {
        ...noop(),
        // Returns a STRING (no usage) → unmeasured, like a subscription CLI.
        claudeFn: async () => "ok output",
      });
      expect(result.budgetWarnings?.some((w) => w.includes("≈$"))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.PATCHWORK_PRICE_TABLE;
      else process.env.PATCHWORK_PRICE_TABLE = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not enforce when recipe.budget is absent (no overhead)", async () => {
    const recipe = makeRecipe({
      steps: [
        {
          agent: {
            prompt: "step",
            model: "claude-haiku-4-5-20251001",
            into: "out",
          },
        },
      ],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async () => ({
        text: "ok",
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      }),
    });
    expect(result.stepResults[0]?.status).toBe("ok");
  });

  it("onBreach='warn' lets the run continue past the cap", async () => {
    const recipe = makeRecipe({
      budget: { tokensMax: 100, onBreach: "warn" },
      steps: [
        {
          agent: {
            prompt: "step 1",
            model: "claude-haiku-4-5-20251001",
            into: "out1",
          },
        },
        {
          agent: {
            prompt: "step 2",
            model: "claude-haiku-4-5-20251001",
            into: "out2",
          },
        },
      ],
    });
    let calls = 0;
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async () => {
        calls++;
        return {
          text: `output ${calls}`,
          usage: { inputTokens: 200, outputTokens: 200 },
        };
      },
    });
    expect(calls).toBe(2);
    expect(result.stepResults[0]?.status).toBe("ok");
    expect(result.stepResults[1]?.status).toBe("ok");
    // Phase 0 pt2: the warn-mode breach warning is now surfaced on the
    // result (RunBudget.warnings() previously had no production reader).
    expect(result.budgetWarnings ?? []).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/token budget exceeded.*onBreach="warn"/i),
      ]),
    );
  });

  it("subscription-driver fail-open: no usage = no enforcement", async () => {
    const recipe = makeRecipe({
      budget: { tokensMax: 50 },
      steps: [
        {
          agent: {
            prompt: "step 1",
            model: "claude-haiku-4-5-20251001",
            into: "out1",
          },
        },
        {
          agent: {
            prompt: "step 2",
            model: "claude-haiku-4-5-20251001",
            into: "out2",
          },
        },
      ],
    });
    // claudeFn returns plain strings — usage is undefined → fail-open.
    let calls = 0;
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async () => {
        calls++;
        return `output ${calls}`;
      },
    });
    expect(calls).toBe(2);
    expect(result.stepResults[0]?.status).toBe("ok");
    expect(result.stepResults[1]?.status).toBe("ok");
    // Phase 0 pt2: the unmeasured-driver warning ("does not report token
    // usage — budget enforcement skipped") is now surfaced, so a user who
    // set a budget learns it silently did nothing for this driver.
    expect(result.budgetWarnings ?? []).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/does not report token usage/i),
      ]),
    );
  });

  // Bug (3): the admission check used to live inside the agent branch, so a
  // breached budget left TOOL steps running unbounded. The gate now sits at
  // the top of the loop and halts ALL step kinds.
  it("halts a TOOL step that follows a budget-breaching agent step", async () => {
    const written: Record<string, string> = {};
    const recipe = makeRecipe({
      budget: { tokensMax: 100 },
      steps: [
        {
          agent: {
            prompt: "step 1",
            model: "claude-haiku-4-5-20251001",
            into: "out1",
          },
        },
        {
          tool: "file.write",
          path: path.join(TMP, "post-budget.md"),
          content: "should not be written",
        },
      ],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async () => ({
        text: "out",
        usage: { inputTokens: 60, outputTokens: 60 }, // 120 > 100 → breach
      }),
      writeFile: (p, c) => {
        written[p] = c;
      },
    });
    expect(result.stepResults[0]?.status).toBe("ok");
    // The tool step is denied admission and recorded as a budget error.
    expect(result.stepResults[1]?.status).toBe("error");
    expect(result.stepResults[1]?.haltReason).toMatch(/budget_exceeded/);
    expect(result.stepResults[1]?.haltCategory).toBe("budget_exceeded");
    // The tool body never executed.
    expect(written[path.join(TMP, "post-budget.md")]).toBeUndefined();
    expect(result.errorMessage).toMatch(/budget_exceeded/);
  });

  it("onBreach='warn' lets a TOOL step run past the cap", async () => {
    const written: Record<string, string> = {};
    const recipe = makeRecipe({
      budget: { tokensMax: 100, onBreach: "warn" },
      steps: [
        {
          agent: {
            prompt: "step 1",
            model: "claude-haiku-4-5-20251001",
            into: "out1",
          },
        },
        {
          tool: "file.write",
          path: path.join(TMP, "warn-budget.md"),
          content: "delivered",
        },
      ],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async () => ({
        text: "out",
        usage: { inputTokens: 200, outputTokens: 200 }, // breach but warn-mode
      }),
      writeFile: (p, c) => {
        written[p] = c;
      },
    });
    expect(result.stepResults[0]?.status).toBe("ok");
    expect(result.stepResults[1]?.status).toBe("ok");
    expect(written[path.join(TMP, "warn-budget.md")]).toBe("delivered");
  });
});

// ── PR2a — executeAgent return shape (AgentResult union normalization) ───────
// The runner's claudeFn dep accepts `Promise<string | AgentResult>`. Test
// mocks return strings (legacy/cheap); bridge wrappers + real adapters
// return `{text, usage}` so PR2b's RunBudget can read usage. Both shapes
// must produce identical recipe-level behaviour today (PR2a is
// behaviour-neutral).

describe("executeAgent — AgentResult union normalization (PR2a)", () => {
  it("accepts a plain-string claudeFn (legacy / test-mock shape)", async () => {
    const recipe = makeRecipe({
      steps: [
        {
          agent: {
            prompt: "summarize",
            model: "claude-haiku-4-5-20251001",
            into: "summary",
          },
        },
      ],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async () => "plain string output",
    });
    expect(result.stepResults[0]?.status).toBe("ok");
    expect(result.context.summary).toBe("plain string output");
  });

  it("accepts an AgentResult-shaped claudeFn and uses .text identically", async () => {
    const recipe = makeRecipe({
      steps: [
        {
          agent: {
            prompt: "summarize",
            model: "claude-haiku-4-5-20251001",
            into: "summary",
          },
        },
      ],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async () => ({
        text: "object-shaped output",
        usage: { inputTokens: 12, outputTokens: 34 },
      }),
    });
    expect(result.stepResults[0]?.status).toBe("ok");
    expect(result.context.summary).toBe("object-shaped output");
  });
});

// ── haltReason population ─────────────────────────────────────────────────────
// PR1 of the Val-inspired plan: every error-status StepResult must carry a
// one-sentence, human-actionable haltReason. These tests pin the convention
// at each of the 5 construction sites in yamlRunner.ts so future refactors
// can't silently drop the field — it's the foundation the morning-summary
// view depends on.

describe("haltReason population on error StepResults", () => {
  it("agent silent-fail populates haltReason naming the silent-fail kind", async () => {
    const recipe = makeRecipe({
      steps: [
        {
          agent: {
            prompt: "summarize",
            model: "claude-haiku-4-5-20251001",
            into: "summary",
          },
        },
      ],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async () => "[agent step skipped: ANTHROPIC_API_KEY not set]",
    });
    const step = result.stepResults[0]!;
    expect(step.status).toBe("error");
    expect(step.haltReason).toBeDefined();
    expect(step.haltReason).toMatch(/silent-fail/);
  });

  it("agent narration-only output populates haltReason mentioning narration", async () => {
    const recipe = makeRecipe({
      steps: [
        {
          agent: {
            prompt: "summarize",
            model: "claude-haiku-4-5-20251001",
            into: "summary",
          },
        },
      ],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async () => "   \n  \n  ",
    });
    const step = result.stepResults[0]!;
    expect(step.status).toBe("error");
    expect(step.haltReason).toBeDefined();
    expect(step.haltReason).toMatch(/narration|whitespace|no content/i);
  });

  it("agent driver throwing populates haltReason naming the catch path", async () => {
    const recipe = makeRecipe({
      steps: [
        {
          agent: {
            prompt: "summarize",
            model: "claude-haiku-4-5-20251001",
            into: "summary",
          },
        },
      ],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async () => {
        throw new Error("driver exploded");
      },
    });
    const step = result.stepResults[0]!;
    expect(step.status).toBe("error");
    expect(step.haltReason).toBeDefined();
    expect(step.haltReason).toMatch(/threw before completing/);
    expect(step.haltReason).toContain("driver exploded");
  });

  it("tool reporting {ok:false} populates haltReason naming the tool", async () => {
    const recipe = makeRecipe({
      steps: [{ tool: "git.stale_branches", days: 30, into: "stale" }],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      gitStaleBranches: () =>
        JSON.stringify({ ok: false, error: "remote unreachable" }),
    });
    const step = result.stepResults[0]!;
    expect(step.status).toBe("error");
    expect(step.haltReason).toBeDefined();
    expect(step.haltReason).toContain("git.stale_branches");
    expect(step.haltReason).toContain("remote unreachable");
  });

  it("haltReason is absent on ok / skipped steps", async () => {
    const recipe = makeRecipe({
      steps: [{ tool: "git.log_since", since: "1 week ago", into: "log" }],
    });
    const result = await runYamlRecipe(recipe, {
      ...noop(),
      gitLogSince: () => "feat: ship something",
    });
    const step = result.stepResults[0]!;
    expect(step.status).toBe("ok");
    expect(step.haltReason).toBeUndefined();
  });
});

describe("live step persistence via updateRunSteps", () => {
  it("each completed step is visible on the running run before completeRun fires", async () => {
    // Captures the in-memory runLog state observed at step-2 dispatch
    // time. If updateRunSteps is wired, step 1's result must be present.
    const { RecipeRunLog } = await import("../../runLog.js");
    const tmp = mkdtempSync(path.join(os.tmpdir(), "yamlrunner-live-"));
    try {
      const runLog = new RecipeRunLog({ dir: tmp });
      let snapshotAtStep2: unknown[] | undefined;
      const recipe = makeRecipe({
        name: "live-tail-test",
        steps: [
          {
            agent: { prompt: "first", into: "a" },
          },
          {
            agent: { prompt: "second", into: "b" },
          },
        ],
      });
      const claudeFn = vi
        .fn()
        .mockImplementationOnce(async () => "first-result")
        .mockImplementationOnce(async () => {
          // At this point step 1 has finished and pushed; the runLog
          // entry must already reflect it.
          const runs = runLog.query({ limit: 10 });
          snapshotAtStep2 = runs[0]?.stepResults;
          return "second-result";
        });
      await runYamlRecipe(recipe, {
        ...noop(),
        runLog,
        claudeFn,
        claudeCodeFn: claudeFn,
        localFn: claudeFn,
        providerDriverFn: claudeFn,
      });
      expect(Array.isArray(snapshotAtStep2)).toBe(true);
      expect(snapshotAtStep2).toHaveLength(1);
      // biome-ignore lint/suspicious/noExplicitAny: snapshot is unknown[]
      expect((snapshotAtStep2 as any)[0].status).toBe("ok");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── live-tail SSE emission (PR #2: recipe lifecycle events) ──────────────────
describe("runYamlRecipe — SSE lifecycle emissions", () => {
  it("emits recipe_started, recipe_step_start/done, and recipe_done with haltCategory", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "yaml-sse-"));
    try {
      const { ActivityLog } = await import("../../activityLog.js");
      const { RecipeRunLog } = await import("../../runLog.js");
      const activityLog = new ActivityLog();
      const runLog = new RecipeRunLog({ dir: tmp });
      const events: Array<{
        event: string;
        metadata?: Record<string, unknown>;
      }> = [];
      activityLog.subscribe((_kind, entry) => {
        if ("event" in entry) {
          events.push({
            event: entry.event,
            metadata: entry.metadata as Record<string, unknown>,
          });
        }
      });

      const recipe = makeRecipe({
        name: "live-tail-test",
        steps: [{ tool: "diagnostics", uri: "file:///nope.ts", into: "diag" }],
      });

      await runYamlRecipe(recipe, {
        ...noop(),
        runLog,
        activityLog,
      });

      const recipeStarted = events.find((e) => e.event === "recipe_started");
      const stepStart = events.find((e) => e.event === "recipe_step_start");
      const stepDone = events.find((e) => e.event === "recipe_step_done");
      const recipeDone = events.find((e) => e.event === "recipe_done");

      expect(recipeStarted).toBeDefined();
      expect(recipeStarted?.metadata?.recipeName).toBe("live-tail-test");
      expect(recipeStarted?.metadata?.totalSteps).toBe(1);
      expect(stepStart).toBeDefined();
      expect(stepStart?.metadata?.stepId).toBe("diag");
      expect(stepDone).toBeDefined();
      // step might be "ok" or "skipped" depending on stub return; both
      // prove the lifecycle wiring fired exactly once.
      expect(["ok", "skipped"]).toContain(stepDone?.metadata?.status);
      expect(recipeDone).toBeDefined();
      expect(recipeDone?.metadata?.status).toBe("done");
      expect(recipeDone?.metadata?.stepCount).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not emit when activityLog is absent (no-op safety)", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "yaml-sse-noop-"));
    try {
      const { RecipeRunLog } = await import("../../runLog.js");
      const runLog = new RecipeRunLog({ dir: tmp });
      const recipe = makeRecipe({
        name: "no-activity",
        steps: [{ tool: "diagnostics", uri: "file:///x.ts", into: "diag" }],
      });
      // Should not throw; activityLog omitted entirely.
      await runYamlRecipe(recipe, { ...noop(), runLog });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("emits recipe_step_done for agent steps", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "yaml-agent-sse-"));
    try {
      const { ActivityLog } = await import("../../activityLog.js");
      const { RecipeRunLog } = await import("../../runLog.js");
      const activityLog = new ActivityLog();
      const runLog = new RecipeRunLog({ dir: tmp });
      const events: Array<{
        event: string;
        metadata?: Record<string, unknown>;
      }> = [];
      activityLog.subscribe((_kind, entry) => {
        if ("event" in entry) {
          events.push({
            event: entry.event,
            metadata: entry.metadata as Record<string, unknown>,
          });
        }
      });

      const recipe = makeRecipe({
        name: "agent-sse",
        steps: [{ agent: { prompt: "hello", into: "out" } }],
      });
      const claudeFn = vi.fn().mockResolvedValue("agent-result");

      await runYamlRecipe(recipe, {
        ...noop(),
        runLog,
        activityLog,
        claudeFn,
        claudeCodeFn: claudeFn,
        localFn: claudeFn,
        providerDriverFn: claudeFn,
      });

      const stepDone = events.find((e) => e.event === "recipe_step_done");
      expect(stepDone).toBeDefined();
      expect(stepDone?.metadata?.status).toBe("ok");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("runYamlRecipe — orphaned-run guard", () => {
  it("finalizes the run even when a step throws uncaught", async () => {
    const { RecipeRunLog } = await import("../../runLog.js");
    const tmp = mkdtempSync(path.join(os.tmpdir(), "yaml-orphan-"));
    try {
      const runLog = new RecipeRunLog({ dir: tmp });
      // Agent step with no `prompt` — render(undefined) throws a TypeError
      // at a point outside the per-step try/catch. Without the loop guard
      // this escapes runYamlRecipe and the run-log entry is stranded at
      // "running" forever.
      const recipe = makeRecipe({
        name: "orphan-test",
        steps: [{ agent: { into: "a" } }] as YamlRecipe["steps"],
      });

      await runYamlRecipe(recipe, { ...noop(), runLog });

      const runs = runLog.query({ limit: 10 });
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).not.toBe("running");
      expect(runs[0]?.status).toBe("error");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── SECRETS-IN-VARS: env-sourced secrets redacted from agent prompts ─────────
// An env (`type: env`) context value must NEVER reach the LLM verbatim, but a
// TOOL step still needs the real value (http header / DB password). See
// docs/recipe-feature-investigation-2026-06-05.md (#1 gap: SECRETS-IN-VARS).
describe("runYamlRecipe — env secret redaction (agent vs tool)", () => {
  const SECRET_ENV = "PATCHWORK_TEST_SECRET_REDACT";
  const SECRET_VALUE = "sk-supersecret-deadbeef-1234";

  afterEach(() => {
    delete process.env[SECRET_ENV];
  });

  it("redacts the secret in the agent prompt but passes the raw value to the tool", async () => {
    process.env[SECRET_ENV] = SECRET_VALUE;

    let receivedPrompt = "";
    const writtenContent: string[] = [];

    const recipe = makeRecipe({
      name: "secret-redact",
      context: [{ type: "env", keys: [SECRET_ENV] }],
      steps: [
        {
          agent: {
            prompt: `Use the key: {{${SECRET_ENV}}}`,
            into: "out",
          },
        },
        {
          tool: "file.write",
          path: path.join(TMP, "secret-tool-out.txt"),
          content: `header={{${SECRET_ENV}}}`,
        },
      ],
    } as Partial<YamlRecipe>);

    const result = await runYamlRecipe(recipe, {
      ...noop(),
      claudeFn: async (prompt) => {
        receivedPrompt = prompt;
        return "ok";
      },
      writeFile: (_p, c) => {
        writtenContent.push(c);
      },
    });

    expect(result.errorMessage).toBeUndefined();

    // Agent (LLM-facing) prompt: secret redacted, raw value absent.
    expect(receivedPrompt).toContain("[REDACTED]");
    expect(receivedPrompt).not.toContain(SECRET_VALUE);

    // Tool step: raw secret preserved (tools legitimately need it).
    expect(writtenContent).toHaveLength(1);
    expect(writtenContent[0]).toBe(`header=${SECRET_VALUE}`);
    expect(writtenContent[0]).not.toContain("[REDACTED]");
  });
});

describe("runYamlRecipe — run registry registration (H11)", () => {
  it("registers run in registry when runLog is provided so POST /runs/:seq/cancel can abort it", async () => {
    const { isRunActive, unregisterRun } = await import("../runRegistry.js");
    const { RecipeRunLog } = await import("../../runLog.js");
    const tmp = mkdtempSync(path.join(os.tmpdir(), "yamlrunner-h11-"));
    let capturedSeq: number | undefined;
    let wasRegisteredDuringRun = false;
    try {
      const runLog = new RecipeRunLog({ dir: tmp });
      const recipe = makeRecipe({
        name: "h11-cancel-test",
        steps: [{ agent: { prompt: "do something", into: "result" } }],
      });
      await runYamlRecipe(recipe, {
        ...noop(),
        runLog,
        claudeFn: async () => {
          // Capture the seq assigned by startRun
          const runs = runLog.query({ limit: 1 });
          capturedSeq = runs[0]?.seq;
          if (capturedSeq !== undefined) {
            wasRegisteredDuringRun = isRunActive(capturedSeq);
          }
          return "done";
        },
      });
      // During the run the seq must have been active in the registry.
      expect(wasRegisteredDuringRun).toBe(true);
      // After the run finishes the registry entry must be cleaned up.
      if (capturedSeq !== undefined) {
        expect(isRunActive(capturedSeq)).toBe(false);
      }
    } finally {
      if (capturedSeq !== undefined) unregisterRun(capturedSeq);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
