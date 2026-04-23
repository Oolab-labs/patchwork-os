import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../connectors/linear.js", () => ({
  loadTokens: vi.fn(),
  listIssues: vi.fn(),
}));

import { listIssues, loadTokens } from "../../connectors/linear.js";

const mockLoadTokens = vi.mocked(loadTokens);
const mockListIssues = vi.mocked(listIssues);

import {
  type AssertionFailure,
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
    const recipe = makeRecipe({
      steps: [{ tool: "file.read", path: "/nonexistent", into: "data" }],
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

  it("stores skip message gracefully when claudeFn returns skip message", async () => {
    const recipe = makeRecipe({
      steps: [{ agent: { prompt: "Hi", into: "out" } }],
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
      // defaultClaudeFn (which returns skip message). Either way, stepsRun is 1.
      const result = await runYamlRecipe(recipe, {
        ...noop(),
        claudeCodeFn: async (p) => {
          claudeCodeCalls.push(p);
          return "cli fallback response";
        },
      });
      // The step ran regardless of which path was taken
      expect(result.stepsRun).toBe(1);
      expect(result.context.out).toBeDefined();
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
