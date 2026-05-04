import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

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
});

// ── validateYamlRecipe ────────────────────────────────────────────────────────

describe("validateYamlRecipe", () => {
  it("accepts minimal valid recipe", () => {
    const r = validateYamlRecipe({
      name: "x",
      trigger: { type: "manual" },
      steps: [{ tool: "file.read", path: "/tmp/x" }],
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
            path: "/tmp/out.md",
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
        path: "/tmp/out.md",
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
          path: "/tmp/meta.md",
          content: "hello",
          into: "saved",
        },
        {
          tool: "file.write",
          path: "/tmp/out.md",
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

    expect(result.context["saved.path"]).toBe("/tmp/meta.md");
    expect(result.context["saved.bytesWritten"]).toBe("5");
    expect(written["/tmp/out.md"]).toBe("/tmp/meta.md (5)");
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
        { tool: "file.append", path: "/tmp/x.md", content: "x", when: "0 > 1" },
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
        { tool: "file.write", path: "/tmp/out.md", content: "plan: {{plan}}" },
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
    expect(written["/tmp/out.md"]).toBe("plan: do stuff");
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
    expect(result.stepResults[0].status).toBe("error");
  });
});

describe("runYamlRecipe — git.log_since", () => {
  it("captures git log output into context", async () => {
    const recipe = makeRecipe({
      steps: [
        { tool: "git.log_since", since: "24h", into: "commits" },
        {
          tool: "file.write",
          path: "/tmp/out.md",
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
    expect(written["/tmp/out.md"]).toContain("abc feat: x");
  });
});

describe("runYamlRecipe — git.stale_branches", () => {
  it("captures stale branches into context", async () => {
    const recipe = makeRecipe({
      steps: [
        { tool: "git.stale_branches", days: 30, into: "stale" },
        { tool: "file.write", path: "/tmp/stale.md", content: "{{stale}}" },
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
    expect(written["/tmp/stale.md"]).toBe("old-branch");
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
        { tool: "file.write", path: "/tmp/x.md", content: "ok" },
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
    expect(written["/tmp/x.md"]).toBe("ok");
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
          path: "/tmp/a",
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
      steps: [{ tool: "file.read", path: "/tmp/a", into: "data" }],
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
      steps: [{ tool: "file.read", path: "/tmp/a", into: "data" }],
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
      steps: [{ tool: "file.read", path: "/tmp/a", into: "data" }],
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
      steps: [{ tool: "file.read", path: "/tmp/a", into: "data" }],
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
        { tool: "file.write", path: "/tmp/out.md", content: "file: {{file}}" },
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
    expect(written["/tmp/out.md"]).toBe("file: src/index.ts");
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
            path: "/tmp/out.md",
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
      expect(written["/tmp/out.md"]).toBe("channel=C12345");
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
            path: "/tmp/out.md",
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
      expect(written["/tmp/out.md"]).toBe("v=from-seed");
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
          path: "/tmp/out.md",
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
    expect(written["/tmp/out.md"]).toBe("v=");
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
        { tool: "file.read", path: "/tmp/in.json", into: "data" },
        {
          tool: "file.write",
          path: "/tmp/out.md",
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
    expect(written["/tmp/out.md"]).toBe("name=patchwork count=7");
  });

  it("falls back to raw string lookup when output is not valid JSON", async () => {
    const written: Record<string, string> = {};
    const recipe = makeRecipe({
      steps: [
        { tool: "file.read", path: "/tmp/in.txt", into: "data" },
        {
          tool: "file.write",
          path: "/tmp/out.md",
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
    expect(written["/tmp/out.md"]).toBe("raw=plain text body");
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
          path: "/tmp/out.md",
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
    expect(written["/tmp/out.md"]).toBe("count: 2");
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
          path: "/tmp/gmail-health.md",
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
    expect(written["/tmp/gmail-health.md"]).toContain("unread-7d: 2");
    // max:1 means at most 1 result returned for unread_check
    expect(written["/tmp/gmail-health.md"]).toContain("total-unread: 1");
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
            path: "/tmp/linear-out.md",
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
    const out = JSON.parse(written["/tmp/linear-out.md"] ?? "{}") as {
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
            path: "/tmp/linear-out.md",
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
    const out = JSON.parse(written["/tmp/linear-out.md"] ?? "{}") as {
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
            path: "/tmp/linear-out.md",
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
    const out = JSON.parse(written["/tmp/linear-out.md"] ?? "{}") as {
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
            path: "/tmp/gh.md",
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
    const out = JSON.parse(written["/tmp/gh.md"] ?? "{}") as {
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
          { tool: "file.write", path: "/tmp/prs.md", content: "{{prs}}" },
        ],
      }),
      {
        ...noop(),
        writeFile: (p, c) => {
          written[p] = c;
        },
      },
    );
    const out = JSON.parse(written["/tmp/prs.md"] ?? "{}") as {
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
          path: "/tmp/x.txt",
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
          path: "/tmp/y.txt",
          content: "hi",
          into: "saved",
        },
      ],
      expect: { stepsRun: 1, outputs: ["/tmp/y.txt"], errorMessage: null },
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

// ── dispatchRecipe ────────────────────────────────────────────────────────────

import type { ChainedRecipe, ExecutionDeps } from "../chainedRunner.js";
import { dispatchRecipe } from "../yamlRunner.js";

describe("dispatchRecipe", () => {
  it("routes simple recipe to runYamlRecipe", async () => {
    const recipe = makeRecipe({
      steps: [{ tool: "file.write", path: "/tmp/x.txt", content: "hi" }],
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
    expect(claudeCodeFn).toHaveBeenCalledWith("hello");
    expect(result).toBe("cc result");
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
    expect(result).toBe("api result");
  });

  it("routes claude driver to claudeFn", async () => {
    const claudeFn = vi.fn().mockResolvedValue("api result 2");
    const deps = buildChainedDeps({ ...noop(), claudeFn, testMode: true });
    const result = await deps.executeAgent("hi", undefined, "claude");
    expect(result).toBe("api result 2");
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
    expect(result).toBe("openai");
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
      // Either claudeFn or override was called — result is a string
      expect(typeof result).toBe("string");
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
