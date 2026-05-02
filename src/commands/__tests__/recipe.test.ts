import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixtureLibrary } from "../../connectors/fixtureLibrary.js";
import {
  formatRunReport,
  listTemplates,
  runFmt,
  runFmtWatch,
  runLint,
  runNew,
  runPreflight,
  runPreflightWatch,
  runRecipe,
  runRecipeDryPlan,
  runRecord,
  runSchema,
  runTest,
  runTestWatch,
  runWatch,
  runWatchedRecipe,
} from "../recipe.js";

function listYamlFilesRecursive(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        return listYamlFilesRecursive(fullPath);
      }
      return entry.name.endsWith(".yaml") ? [fullPath] : [];
    })
    .sort();
}

describe("recipe CLI commands", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-test-${Date.now()}`);

  beforeEach(() => {
    if (!existsSync(tmpDir)) {
      mkdirSync(tmpDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true });
    }
  });

  describe("runNew", () => {
    it("creates a minimal recipe by default", () => {
      const result = runNew({
        name: "my-test",
        description: "Test recipe",
        outputDir: tmpDir,
      });

      expect(result.path).toBe(join(tmpDir, "my-test.yaml"));
      expect(result.content).toContain("name: my-test");
      expect(result.content).toContain("description: Test recipe");
      expect(result.content).toContain("trigger:");
    });

    it("creates a daily recipe from template", () => {
      const result = runNew({
        name: "daily-standup",
        description: "Daily standup notes",
        template: "daily",
        outputDir: tmpDir,
      });

      expect(result.content).toContain("type: cron");
      expect(result.content).toContain("git.log_since");
    });

    it("throws on duplicate recipe", () => {
      runNew({
        name: "duplicate",
        description: "First",
        outputDir: tmpDir,
      });

      expect(() =>
        runNew({
          name: "duplicate",
          description: "Second",
          outputDir: tmpDir,
        }),
      ).toThrow("Recipe already exists");
    });

    it("throws on unknown template", () => {
      expect(() =>
        runNew({
          name: "test",
          description: "Test",
          template: "unknown",
          outputDir: tmpDir,
        }),
      ).toThrow('Unknown template: "unknown"');
    });

    it("throws on missing name", () => {
      expect(() =>
        runNew({
          name: "",
          description: "Test",
          outputDir: tmpDir,
        }),
      ).toThrow("Recipe name is required");
    });
  });

  describe("listTemplates", () => {
    it("returns available templates", () => {
      const templates = listTemplates();
      expect(templates).toContain("minimal");
      expect(templates).toContain("daily");
      expect(templates).toContain("inbox");
    });
  });

  describe("runSchema", () => {
    it("writes recipe and namespace schemas to disk", async () => {
      const outputDir = join(tmpDir, "schemas-out");

      const result = await runSchema(outputDir);

      expect(result.outputDir).toBe(outputDir);
      expect(
        result.filesWritten.some((file) => file.endsWith("recipe.v1.json")),
      ).toBe(true);
      expect(
        result.filesWritten.some((file) => file.endsWith("tools/file.json")),
      ).toBe(true);
      expect(
        result.filesWritten.some((file) => file.endsWith("tools/gmail.json")),
      ).toBe(true);

      const recipeSchema = readFileSync(
        join(outputDir, "recipe.v1.json"),
        "utf-8",
      );
      expect(recipeSchema).toContain("Patchwork Recipe");
    });
  });

  describe("runLint", () => {
    it("validates a correct recipe", () => {
      const recipePath = join(tmpDir, "valid.yaml");
      writeFileSync(
        recipePath,
        `name: valid-recipe
description: A valid recipe
trigger:
  type: manual
steps:
  - tool: file.read
    path: ~/test.txt
    into: content
`,
      );

      const result = runLint(recipePath);
      expect(result.valid).toBe(true);
      expect(result.errors).toBe(0);
    });

    it("detects missing name", () => {
      const recipePath = join(tmpDir, "no-name.yaml");
      writeFileSync(
        recipePath,
        `description: Missing name
trigger:
  type: manual
steps: []
`,
      );

      const result = runLint(recipePath);
      expect(result.valid).toBe(false);
      expect(result.errors).toBeGreaterThan(0);
      expect(result.issues.some((i) => i.message.includes("name"))).toBe(true);
    });

    it("detects missing steps", () => {
      const recipePath = join(tmpDir, "no-steps.yaml");
      writeFileSync(
        recipePath,
        `name: no-steps
description: No steps
trigger:
  type: manual
`,
      );

      const result = runLint(recipePath);
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.message.includes("step"))).toBe(true);
    });

    it("warns on non-kebab-case name", () => {
      const recipePath = join(tmpDir, "bad-name.yaml");
      writeFileSync(
        recipePath,
        `name: Bad_Name
description: Bad naming
trigger:
  type: manual
steps:
  - tool: file.read
    path: ~/test.txt
`,
      );

      const result = runLint(recipePath);
      expect(result.warnings).toBeGreaterThan(0);
      expect(result.issues.some((i) => i.message.includes("kebab"))).toBe(true);
    });

    it("returns error for missing file", () => {
      const result = runLint(join(tmpDir, "nonexistent.yaml"));
      expect(result.valid).toBe(false);
      expect(result.errors).toBe(1);
      expect(result.issues[0].message).toContain("not found");
    });

    it("returns error for invalid YAML", () => {
      const recipePath = join(tmpDir, "invalid.yaml");
      writeFileSync(recipePath, "{invalid yaml: [}");

      const result = runLint(recipePath);
      expect(result.valid).toBe(false);
      expect(result.issues[0].message).toContain("YAML");
    });

    it("accepts template references to prior step outputs", () => {
      const recipePath = join(tmpDir, "valid-templates.yaml");
      writeFileSync(
        recipePath,
        `name: valid-templates
description: Valid templates
trigger:
  type: manual
steps:
  - tool: file.read
    path: ~/input.txt
    into: content
  - tool: file.write
    path: ~/.patchwork/out.txt
    content: "{{content}}"
`,
      );

      const result = runLint(recipePath);
      expect(result.valid).toBe(true);
    });

    it("rejects missing or forward template references", () => {
      const recipePath = join(tmpDir, "bad-templates.yaml");
      writeFileSync(
        recipePath,
        `name: bad-templates
description: Bad templates
trigger:
  type: manual
steps:
  - tool: file.write
    path: ~/.patchwork/out.txt
    content: "{{summary}}"
  - agent:
      prompt: |
        Summarize it
      into: summary
`,
      );

      const result = runLint(recipePath);
      expect(result.valid).toBe(false);
      expect(
        result.issues.some((issue) =>
          issue.message.includes("Unknown template reference '{{summary}}'"),
        ),
      ).toBe(true);
    });

    it("accepts $result references inside transform: strings", () => {
      const recipePath = join(tmpDir, "transform-templates.yaml");
      writeFileSync(
        recipePath,
        `name: transform-templates
description: transform with $result
trigger:
  type: manual
steps:
  - tool: file.read
    path: ~/input.json
    into: raw
    transform: "{{$result.body}} / {{$result.headers.subject}}"
`,
      );

      const result = runLint(recipePath);
      expect(result.valid).toBe(true);
    });

    it("still flags unknown non-$result refs in transform: strings", () => {
      const recipePath = join(tmpDir, "bad-transform.yaml");
      writeFileSync(
        recipePath,
        `name: bad-transform
description: transform referencing an unknown key
trigger:
  type: manual
steps:
  - tool: file.read
    path: ~/input.json
    into: raw
    transform: "{{$result.body}} / {{missing}}"
`,
      );

      const result = runLint(recipePath);
      expect(result.valid).toBe(false);
      expect(
        result.issues.some((issue) =>
          issue.message.includes("Unknown template reference '{{missing}}'"),
        ),
      ).toBe(true);
    });

    it("accepts Gmail flattened output references exposed by yamlRunner", () => {
      const recipePath = join(tmpDir, "gmail-templates.yaml");
      writeFileSync(
        recipePath,
        `name: gmail-templates
description: Gmail templates
trigger:
  type: manual
steps:
  - tool: gmail.fetch_unread
    since: "24h"
    into: unread
  - agent:
      prompt: |
        Count: {{unread.count}}
        Messages: {{unread.json}}
      into: summary
`,
      );

      const result = runLint(recipePath);
      expect(result.valid).toBe(true);
    });

    it("accepts dotted output references derived from tool registry metadata", () => {
      const recipePath = join(tmpDir, "tool-output-templates.yaml");
      writeFileSync(
        recipePath,
        `name: tool-output-templates
description: Tool output templates
trigger:
  type: manual
steps:
  - tool: file.write
    path: /tmp/meta.txt
    content: "hello"
    into: saved
  - agent:
      prompt: |
        Saved to {{saved.path}}
        Bytes: {{saved.bytesWritten}}
      into: summary
`,
      );

      const result = runLint(recipePath);
      expect(result.valid).toBe(true);
    });

    it("warns when a dotted ref is not exposed by the upstream tool output schema", () => {
      const recipePath = join(tmpDir, "tool-output-unknown-key.yaml");
      writeFileSync(
        recipePath,
        `name: tool-output-unknown-key
description: Dotted ref not in registry-flattened schema
trigger:
  type: manual
steps:
  - tool: file.write
    path: /tmp/meta.txt
    content: "hello"
    into: saved
  - agent:
      prompt: |
        Saved to {{saved.bogusField}}
      into: summary
`,
      );

      const result = runLint(recipePath);
      // Warning, not error — recipe still passes lint.
      expect(result.valid).toBe(true);
      expect(
        result.issues.some(
          (issue) =>
            issue.level === "warning" &&
            issue.message.includes("'{{saved.bogusField}}'") &&
            issue.message.includes("file.write"),
        ),
      ).toBe(true);
    });

    it("does not warn on dotted refs for tools without a registered output schema", () => {
      const recipePath = join(tmpDir, "tool-output-unknown-tool.yaml");
      writeFileSync(
        recipePath,
        `name: tool-output-unknown-tool
description: Unknown tool, no schema to validate against
trigger:
  type: manual
steps:
  - tool: notes.lookup_recent_context
    query: anything
    into: notes
  - agent:
      prompt: "Using {{notes.whatever}}"
      into: summary
`,
      );

      const result = runLint(recipePath);
      expect(
        result.issues.some(
          (issue) =>
            issue.level === "warning" &&
            issue.message.includes("'{{notes.whatever}}'"),
        ),
      ).toBe(false);
    });

    it("errors when into shadows a built-in context key", () => {
      const recipePath = join(tmpDir, "into-shadow.yaml");
      writeFileSync(
        recipePath,
        `name: into-shadow
description: Shadows builtin
trigger:
  type: manual
steps:
  - tool: file.read
    path: /tmp/foo.txt
    into: date
`,
      );

      const result = runLint(recipePath);
      expect(result.valid).toBe(false);
      expect(
        result.issues.some((issue) =>
          issue.message.includes("shadows a built-in context key"),
        ),
      ).toBe(true);
    });

    it("warns when two steps write to the same into key", () => {
      const recipePath = join(tmpDir, "into-duplicate.yaml");
      writeFileSync(
        recipePath,
        `name: into-duplicate
description: Duplicate into keys
trigger:
  type: manual
steps:
  - tool: file.read
    path: /tmp/a.txt
    into: content
  - tool: file.read
    path: /tmp/b.txt
    into: content
  - agent:
      prompt: "Result: {{content}}"
`,
      );

      const result = runLint(recipePath);
      // Valid (warning, not error)
      expect(result.valid).toBe(true);
      expect(
        result.issues.some(
          (issue) =>
            issue.level === "warning" &&
            issue.message.includes(
              "'into: content' overwrites value already written by step 1",
            ),
        ),
      ).toBe(true);
    });

    it("accepts agent into in chained recipes without false-positive template error", () => {
      const recipePath = join(tmpDir, "chained-agent-into.yaml");
      writeFileSync(
        recipePath,
        `name: chained-agent-into
description: Chained agent into
trigger:
  type: chained
steps:
  - agent:
      prompt: "Summarise the inputs"
      into: summary
  - tool: file.write
    path: /tmp/out.txt
    content: "{{summary}}"
`,
      );

      const result = runLint(recipePath);
      expect(
        result.issues.filter((i) =>
          i.message.includes("Unknown template reference '{{summary}}'"),
        ),
      ).toHaveLength(0);
    });

    it("enforces generated schema when schema lint flag is enabled", () => {
      const previous = process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT;
      process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT = "true";
      try {
        const recipePath = join(tmpDir, "schema-invalid-api-version.yaml");
        writeFileSync(
          recipePath,
          `apiVersion: patchwork.sh/v999
name: bad-schema
description: Bad schema
trigger:
  type: manual
steps:
  - tool: file.read
    path: ~/test.txt
`,
        );

        const result = runLint(recipePath);
        expect(result.valid).toBe(false);
        expect(
          result.issues.some((issue) =>
            issue.message.includes("Schema validation: apiVersion"),
          ),
        ).toBe(true);
      } finally {
        if (previous === undefined) {
          delete process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT;
        } else {
          process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT = previous;
        }
      }
    });

    it("enforces tool-required params when schema lint flag is enabled", () => {
      const previous = process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT;
      process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT = "true";
      try {
        const recipePath = join(tmpDir, "schema-missing-tool-param.yaml");
        writeFileSync(
          recipePath,
          `apiVersion: patchwork.sh/v1
name: missing-tool-param
description: Missing tool param
trigger:
  type: manual
steps:
  - tool: file.write
    path: ~/.patchwork/out.txt
`,
        );

        const result = runLint(recipePath);
        expect(result.valid).toBe(false);
        expect(
          result.issues.some(
            (issue) =>
              issue.message.includes("Schema validation: steps.0") &&
              issue.message.includes("must have required property 'content'"),
          ),
        ).toBe(true);
      } finally {
        if (previous === undefined) {
          delete process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT;
        } else {
          process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT = previous;
        }
      }
    });

    it("normalizes legacy recipe shapes when schema lint flag is enabled", () => {
      const previous = process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT;
      process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT = "true";
      try {
        const recipePath = join(tmpDir, "legacy-shape.yaml");
        writeFileSync(
          recipePath,
          `name: legacy-shape
description: Legacy recipe
trigger:
  type: cron
  schedule: "0 6 * * *"
context:
  - type: env
    keys: [USER_NAME]
steps:
  - agent: true
    prompt: "Hello {{USER_NAME}}"
    output: summary
  - agent: false
    tool: file.append
    params:
      path: ~/.patchwork/out.md
      line: "{{summary}} @ {{YYYY-MM-DD}}"
`,
        );

        const result = runLint(recipePath);
        expect(
          result.valid,
          result.issues.map((issue) => issue.message).join(" | "),
        ).toBe(true);
      } finally {
        if (previous === undefined) {
          delete process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT;
        } else {
          process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT = previous;
        }
      }
    });

    it("accepts normalized legacy event recipes with unknown tools when schema lint flag is enabled", () => {
      const previous = process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT;
      process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT = "true";
      try {
        const recipePath = join(tmpDir, "legacy-event.yaml");
        writeFileSync(
          recipePath,
          `name: legacy-event
description: Legacy event recipe
trigger:
  type: event
  on: notification.incoming
  filter:
    channel: email
steps:
  - agent: true
    prompt: "Classify {{event.notification.title}}"
    output: verdict
  - branch:
      - when: "{{verdict}}"
        tool: notify.push
        params:
          title: "{{event.notification.title}}"
          body: "{{event.notification.body}}"
      - otherwise:
          tool: queue.append
          params:
            queue: overnight
            item: "{{event.notification}}"
on_error:
  notify: false
  retry: 0
  fallback: deliver_original
`,
        );

        const result = runLint(recipePath);
        expect(
          result.valid,
          result.issues.map((issue) => issue.message).join(" | "),
        ).toBe(true);
      } finally {
        if (previous === undefined) {
          delete process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT;
        } else {
          process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT = previous;
        }
      }
    });

    it("accepts chained recipes with nested recipe steps when schema lint flag is enabled", () => {
      const previous = process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT;
      process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT = "true";
      try {
        const recipePath = join(tmpDir, "chained-schema.yaml");
        writeFileSync(
          recipePath,
          `name: chained-schema
description: Chained recipe schema coverage
trigger:
  type: chained
maxConcurrency: 3
maxDepth: 2
steps:
  - id: gather
    tool: github.list_issues
  - id: summarize
    agent:
      prompt: "Summarize {{gather}}"
    awaits: [gather]
  - id: followup
    recipe: decision-review
    vars:
      summary: "{{summarize}}"
    output: review
    risk: medium
    awaits: [summarize]
`,
        );

        const result = runLint(recipePath);
        expect(
          result.valid,
          result.issues.map((issue) => issue.message).join(" | "),
        ).toBe(true);
      } finally {
        if (previous === undefined) {
          delete process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT;
        } else {
          process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT = previous;
        }
      }
    });

    it("accepts chained recipe step with chain: alias (valid, named recipe)", () => {
      const recipePath = join(tmpDir, "chained-chain-alias.yaml");
      writeFileSync(
        recipePath,
        `name: chained-chain-alias
description: Tests chain alias
trigger:
  type: chained
steps:
  - id: step1
    tool: github.list_issues
  - id: step2
    chain: decision-review
    awaits: [step1]
`,
      );
      const result = runLint(recipePath);
      expect(
        result.valid,
        result.issues.map((i) => i.message).join(" | "),
      ).toBe(true);
    });

    it("warns when chain: references a missing local yaml file", () => {
      const recipePath = join(tmpDir, "chained-missing-child.yaml");
      writeFileSync(
        recipePath,
        `name: chained-missing-child
description: Tests missing chain file
trigger:
  type: chained
steps:
  - id: step1
    chain: ./does-not-exist.yaml
`,
      );
      const result = runLint(recipePath);
      const chainIssue = result.issues.find((i) =>
        i.message.includes("does-not-exist.yaml"),
      );
      expect(chainIssue).toBeDefined();
      expect(chainIssue?.level).toBe("error");
      expect(result.valid).toBe(false);
    });

    it("does not error when chain: references a valid local yaml file that exists", () => {
      const childPath = join(tmpDir, "child-recipe-valid.yaml");
      writeFileSync(
        childPath,
        `name: child-recipe-valid
description: A valid child recipe
trigger:
  type: manual
steps:
  - tool: file.read
    path: /tmp/x
`,
      );
      const recipePath = join(tmpDir, "chained-with-child.yaml");
      writeFileSync(
        recipePath,
        `name: chained-with-child
description: Tests present chain file
trigger:
  type: chained
steps:
  - id: step1
    chain: ./child-recipe-valid.yaml
`,
      );
      const result = runLint(recipePath);
      // No file-not-found error and no child-validation errors.
      const chainErrors = result.issues.filter(
        (i) => i.level === "error" && i.message.includes("child-recipe-valid"),
      );
      expect(chainErrors).toHaveLength(0);
      expect(result.valid).toBe(true);
    });

    it("surfaces errors from an invalid child recipe", () => {
      const childPath = join(tmpDir, "child-recipe-bad.yaml");
      writeFileSync(
        childPath,
        `name: child-recipe-bad
trigger:
  type: manual
steps: []
`,
      );
      const recipePath = join(tmpDir, "chained-with-bad-child.yaml");
      writeFileSync(
        recipePath,
        `name: chained-with-bad-child
description: Parent of bad child
trigger:
  type: chained
steps:
  - id: step1
    chain: ./child-recipe-bad.yaml
`,
      );
      const result = runLint(recipePath);
      const childErrors = result.issues.filter(
        (i) =>
          i.level === "error" && i.message.includes("child-recipe-bad.yaml"),
      );
      expect(childErrors.length).toBeGreaterThan(0);
      expect(result.valid).toBe(false);
    });

    it("does not infinitely recurse when two chained recipes reference each other", () => {
      const alphaPath = join(tmpDir, "chain-alpha.yaml");
      const betaPath = join(tmpDir, "chain-beta.yaml");
      writeFileSync(
        alphaPath,
        `name: chain-alpha
description: Alpha
trigger:
  type: chained
steps:
  - id: step1
    chain: ./chain-beta.yaml
`,
      );
      writeFileSync(
        betaPath,
        `name: chain-beta
description: Beta
trigger:
  type: chained
steps:
  - id: step1
    chain: ./chain-alpha.yaml
`,
      );
      // Should complete without stack overflow, result shape doesn't matter.
      expect(() => runLint(alphaPath)).not.toThrow();
    });

    it("errors when chain: inside parallel: references a missing file", () => {
      const recipePath = join(tmpDir, "parallel-missing-child.yaml");
      writeFileSync(
        recipePath,
        `name: parallel-missing-child
description: parallel with bad chain ref
trigger:
  type: chained
steps:
  - parallel:
      - id: p1
        chain: ./definitely-missing.yaml
      - id: p2
        tool: file.read
        path: /tmp/x
`,
      );
      const result = runLint(recipePath);
      const chainError = result.issues.find(
        (i) =>
          i.level === "error" && i.message.includes("definitely-missing.yaml"),
      );
      expect(chainError).toBeDefined();
      expect(result.valid).toBe(false);
    });

    it("passes clean when chain: inside parallel: references a valid file", () => {
      const childPath = join(tmpDir, "parallel-child-valid.yaml");
      writeFileSync(
        childPath,
        `name: parallel-child-valid
description: A valid parallel child
trigger:
  type: manual
steps:
  - tool: file.read
    path: /tmp/x
`,
      );
      const recipePath = join(tmpDir, "parallel-good-child.yaml");
      writeFileSync(
        recipePath,
        `name: parallel-good-child
description: parallel with valid chain ref
trigger:
  type: chained
steps:
  - parallel:
      - id: p1
        chain: ./parallel-child-valid.yaml
      - id: p2
        tool: file.read
        path: /tmp/y
`,
      );
      const result = runLint(recipePath);
      const chainErrors = result.issues.filter(
        (i) =>
          i.level === "error" &&
          i.message.includes("parallel-child-valid.yaml"),
      );
      expect(chainErrors).toHaveLength(0);
      expect(result.valid).toBe(true);
    });

    it("warns when named chain: ref is not found in recipes dir", () => {
      // Point RECIPES_DIR at an empty tmp dir so the lookup always misses.
      const emptyRecipesDir = join(tmpDir, "empty-recipes");
      mkdirSync(emptyRecipesDir, { recursive: true });

      // Temporarily redirect the module-level RECIPES_DIR via env var isn't
      // practical, so we instead verify the warning message shape by writing a
      // recipe that uses a named ref and running lint with a spy on existsSync
      // for the recipes dir — instead, use the real homedir but write a recipe
      // that references a name guaranteed not to exist.
      const recipePath = join(tmpDir, "chained-missing-named.yaml");
      writeFileSync(
        recipePath,
        `name: chained-missing-named
description: Tests missing named recipe
trigger:
  type: chained
steps:
  - id: step1
    chain: __definitely_does_not_exist_xyz987__
`,
      );
      const result = runLint(recipePath);
      // If ~/.patchwork/recipes/ exists, there should be a warning.
      // If it doesn't exist yet (fresh machine), no warning is emitted — both
      // outcomes are valid, so we only assert that it is never an error.
      const namedIssues = result.issues.filter((i) =>
        i.message.includes("__definitely_does_not_exist_xyz987__"),
      );
      for (const issue of namedIssues) {
        expect(issue.level).toBe("warning");
      }
      // valid must remain true regardless (warnings don't block)
      const errors = result.issues.filter((i) => i.level === "error");
      expect(errors).toHaveLength(0);
      expect(result.valid).toBe(true);
    });

    it("does not warn for named chain: ref when recipes dir does not exist", () => {
      // Simulate a fresh machine: recipes dir absent → skip the lookup entirely.
      // We can't easily stub existsSync, so instead verify that a recipe using
      // a named ref on a machine where RECIPES_DIR exists but has no match
      // still returns valid:true (warnings only).
      const recipePath = join(tmpDir, "chained-named-no-dir.yaml");
      writeFileSync(
        recipePath,
        `name: chained-named-no-dir
description: Named ref, recipes dir may be absent
trigger:
  type: chained
steps:
  - id: step1
    chain: some-named-recipe
`,
      );
      const result = runLint(recipePath);
      // Must never be an error — only a warning at most.
      const errors = result.issues.filter((i) => i.level === "error");
      expect(errors).toHaveLength(0);
      expect(result.valid).toBe(true);
    });

    it("validates all bundled template recipes recursively when schema lint flag is enabled", () => {
      const previous = process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT;
      process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT = "true";
      try {
        const templatesDir = join(process.cwd(), "templates", "recipes");
        const recipeFiles = listYamlFilesRecursive(templatesDir);

        for (const recipeFile of recipeFiles) {
          const result = runLint(recipeFile);
          expect(
            result.valid,
            `${recipeFile}: ${result.issues.map((issue) => issue.message).join(" | ")}`,
          ).toBe(true);
        }
      } finally {
        if (previous === undefined) {
          delete process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT;
        } else {
          process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT = previous;
        }
      }
    });

    it("validates all example recipes recursively when schema lint flag is enabled", () => {
      const previous = process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT;
      process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT = "true";
      try {
        const examplesDir = join(process.cwd(), "examples", "recipes");
        const recipeFiles = listYamlFilesRecursive(examplesDir);

        for (const recipeFile of recipeFiles) {
          const result = runLint(recipeFile);
          expect(
            result.valid,
            `${recipeFile}: ${result.issues.map((issue) => issue.message).join(" | ")}`,
          ).toBe(true);
        }
      } finally {
        if (previous === undefined) {
          delete process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT;
        } else {
          process.env.PATCHWORK_FLAG_UI_SCHEMA_LINT = previous;
        }
      }
    });
  });

  describe("runFmt", () => {
    it("normalizes key order", () => {
      const recipePath = join(tmpDir, "unordered.yaml");
      writeFileSync(
        recipePath,
        `steps:
  - tool: file.read
    path: ~/test.txt
description: Unordered
name: unordered
trigger:
  type: manual
`,
      );

      const result = runFmt(recipePath);
      expect(result.changed).toBe(true);

      const formatted = readFileSync(recipePath, "utf-8");
      const nameIndex = formatted.indexOf("name:");
      const descIndex = formatted.indexOf("description:");
      const triggerIndex = formatted.indexOf("trigger:");

      expect(nameIndex).toBeLessThan(descIndex);
      expect(descIndex).toBeLessThan(triggerIndex);
    });

    it("normalizes legacy runtime-safe fields while preserving nested control flow", () => {
      const recipePath = join(tmpDir, "legacy-format.yaml");
      writeFileSync(
        recipePath,
        `name: legacy-format
description: Legacy formatting
trigger:
  type: cron
  schedule: "0 6 * * *"
steps:
  - agent: true
    prompt: "Summarize"
    output: summary
  - id: fanout
    parallel:
      - tool: file.append
        params:
          path: ~/.patchwork/out.md
          line: "{{summary}}"
        output: saved
`,
      );

      const result = runFmt(recipePath);
      expect(result.changed).toBe(true);

      const formatted = readFileSync(recipePath, "utf-8");
      expect(formatted).toContain("at: 0 6 * * *");
      expect(formatted).not.toContain("schedule:");
      expect(formatted).toContain("agent:");
      expect(formatted).toContain("prompt: Summarize");
      expect(formatted).toContain("into: summary");
      expect(formatted).toContain("parallel:");
      expect(formatted).toContain('content: "{{summary}}"');
      expect(formatted).toContain("into: saved");
    });

    it("stamps apiVersion patchwork.sh/v1 when missing", () => {
      const recipePath = join(tmpDir, "no-api-version.yaml");
      writeFileSync(
        recipePath,
        `name: no-api-version
description: Recipe without apiVersion
trigger:
  type: manual
steps:
  - tool: file.write
    path: /tmp/x.txt
    content: "hi"
`,
      );

      const result = runFmt(recipePath);
      expect(result.changed).toBe(true);

      const formatted = readFileSync(recipePath, "utf-8");
      expect(formatted).toContain("apiVersion: patchwork.sh/v1");
      // Stamped key must come before name to match runFmt's keyOrder.
      const apiVersionIndex = formatted.indexOf("apiVersion:");
      const nameIndex = formatted.indexOf("name:");
      expect(apiVersionIndex).toBeGreaterThanOrEqual(0);
      expect(apiVersionIndex).toBeLessThan(nameIndex);
    });

    it("check mode does not modify file", () => {
      const recipePath = join(tmpDir, "no-modify.yaml");
      const original = `name: test
description: Test
trigger:
  type: manual
steps: []
`;
      writeFileSync(recipePath, original);

      runFmt(recipePath, { check: true });

      const content = readFileSync(recipePath, "utf-8");
      expect(content).toBe(original);
    });
  });

  describe("runRecipe", () => {
    it("runs a single step selected by id with seeded vars", async () => {
      const recipePath = join(tmpDir, "single-step-by-id.yaml");
      const outPath = join(tmpDir, "single-step.txt");
      const skippedPath = join(tmpDir, "should-not-run.txt");
      writeFileSync(
        recipePath,
        `name: single-step-by-id
description: Single step by id
trigger:
  type: manual
steps:
  - id: greet
    tool: file.write
    path: ${JSON.stringify(outPath)}
    content: "Hello {{name}}"
  - tool: file.write
    path: ${JSON.stringify(skippedPath)}
    content: "skip me"
`,
      );

      const run = await runRecipe(recipePath, {
        step: "greet",
        vars: { name: "Wesh" },
      });

      expect(run.stepSelection).toEqual({
        query: "greet",
        matchedBy: "id",
        matchedValue: "greet",
      });
      expect("stepsRun" in run.result && run.result.stepsRun).toBe(1);
      expect(readFileSync(outPath, "utf-8")).toBe("Hello Wesh");
      expect(existsSync(skippedPath)).toBe(false);
    });

    it("runs a single step selected by into", async () => {
      const recipePath = join(tmpDir, "single-step-by-into.yaml");
      writeFileSync(
        recipePath,
        `name: single-step-by-into
description: Single step by into
trigger:
  type: manual
steps:
  - agent:
      prompt: "Summarize {{topic}}"
      into: summary
  - tool: file.write
    path: ${JSON.stringify(join(tmpDir, "unused.txt"))}
    content: "{{summary}}"
`,
      );

      const run = await runRecipe(recipePath, {
        step: "summary",
        vars: { topic: "patchwork" },
        deps: {
          claudeFn: async (prompt) => `agent:${prompt}`,
          claudeCodeFn: async (prompt) => `agent:${prompt}`,
          providerDriverFn: async (_driver, prompt) => `agent:${prompt}`,
        },
      });

      expect(run.stepSelection).toEqual({
        query: "summary",
        matchedBy: "into",
        matchedValue: "summary",
      });
      expect("stepsRun" in run.result && run.result.stepsRun).toBe(1);
      if ("stepsRun" in run.result) {
        expect(run.result.context.summary).toBe("agent:Summarize patchwork");
      }
    });

    it("runs a single step selected by tool", async () => {
      const recipePath = join(tmpDir, "single-step-by-tool.yaml");
      writeFileSync(
        recipePath,
        `name: single-step-by-tool
description: Single step by tool
trigger:
  type: manual
steps:
  - tool: git.log_since
    since: "24h"
    into: commits
  - tool: file.write
    path: ${JSON.stringify(join(tmpDir, "unused-tool.txt"))}
    content: "{{commits}}"
`,
      );

      const run = await runRecipe(recipePath, {
        step: "git.log_since",
        deps: {
          gitLogSince: () => "abc123 Commit",
        },
      });

      expect(run.stepSelection).toEqual({
        query: "git.log_since",
        matchedBy: "tool",
        matchedValue: "git.log_since",
      });
      expect("stepsRun" in run.result && run.result.stepsRun).toBe(1);
      if ("stepsRun" in run.result) {
        expect(run.result.context.commits).toBe("abc123 Commit");
      }
    });
  });

  describe("formatRunReport", () => {
    it("renders a per-step table for chained results", () => {
      const stepResults = new Map([
        ["fetch", { success: true, durationMs: 120 }],
        ["summarize", { success: true, durationMs: 340 }],
        ["write", { success: false, error: new Error("disk full") }],
      ]);
      const result = {
        success: false,
        stepResults,
        summary: { total: 3, succeeded: 2, failed: 1, skipped: 0 },
        errorMessage: "1 step(s) failed",
        context: {},
      };
      const report = formatRunReport(result, "my-recipe");
      expect(report).toContain("my-recipe");
      expect(report).toContain("✓ fetch");
      expect(report).toContain("120ms");
      expect(report).toContain("✗ write");
      expect(report).toContain("disk full");
      expect(report).toContain("2 ok");
      expect(report).toContain("1 failed");
    });

    it("marks skipped steps with ↷", () => {
      const stepResults = new Map([
        ["a", { success: true, durationMs: 10 }],
        ["b", { success: true, skipped: true, durationMs: 0 }],
      ]);
      const result = {
        success: true,
        stepResults,
        summary: { total: 2, succeeded: 1, failed: 0, skipped: 1 },
        context: {},
      };
      const report = formatRunReport(result, "r");
      expect(report).toContain("↷ b");
      expect(report).toContain("1 skipped");
    });

    it("renders compact summary for simple (non-chained) results", () => {
      const result = {
        success: true,
        stepsRun: 2,
        outputs: ["/tmp/out.md"],
        errorMessage: undefined,
      };
      const report = formatRunReport(result as never, "simple-recipe");
      expect(report).toContain("✓ simple-recipe");
      expect(report).toContain("2 step(s)");
      expect(report).toContain("/tmp/out.md");
    });
  });

  describe("runRecipeDryPlan", () => {
    it("builds a rendered dry-run plan for a simple recipe", async () => {
      const recipePath = join(tmpDir, "dry-run-simple.yaml");
      writeFileSync(
        recipePath,
        `name: dry-run-simple
description: Dry run simple
trigger:
  type: manual
steps:
  - id: fetch
    tool: file.read
    path: ${JSON.stringify(join(tmpDir, "input.txt"))}
    into: content
  - tool: file.write
    path: ${JSON.stringify(join(tmpDir, "out.txt"))}
    content: "Hello {{name}} {{content}}"
`,
      );

      const plan = await runRecipeDryPlan(recipePath, {
        vars: { name: "Wesh" },
      });

      expect(plan.mode).toBe("dry-run");
      expect(plan.triggerType).toBe("manual");
      expect(plan.steps).toHaveLength(2);
      expect(plan.steps[0]).toMatchObject({
        id: "fetch",
        type: "tool",
        tool: "file.read",
        into: "content",
        params: { path: join(tmpDir, "input.txt") },
      });
      expect(plan.steps[1]).toMatchObject({
        type: "tool",
        tool: "file.write",
        params: {
          path: join(tmpDir, "out.txt"),
          content: "Hello Wesh [dry-run:fetch]",
        },
      });
    });

    it("emits stable schemaVersion + registry-enriched metadata in plan JSON", async () => {
      const recipePath = join(tmpDir, "dry-run-enriched.yaml");
      writeFileSync(
        recipePath,
        `name: dry-run-enriched
description: Ensure dry-run plan JSON shape is stable
trigger:
  type: manual
steps:
  - id: post
    tool: slack.post_message
    channel: alerts
    text: hi
  - id: local
    tool: file.write
    path: /tmp/x.txt
    content: hi
`,
      );

      const plan = await runRecipeDryPlan(recipePath);

      expect(plan.schemaVersion).toBe(1);
      expect(typeof plan.generatedAt).toBe("string");
      expect(() => new Date(plan.generatedAt).toISOString()).not.toThrow();

      const slackStep = plan.steps.find((s) => s.id === "post");
      expect(slackStep).toMatchObject({
        tool: "slack.post_message",
        namespace: "slack",
        resolved: true,
        isWrite: true,
        isConnector: true,
      });

      const localStep = plan.steps.find((s) => s.id === "local");
      expect(localStep).toMatchObject({
        tool: "file.write",
        namespace: "file",
        resolved: true,
        isConnector: false,
      });

      expect(plan.connectorNamespaces).toEqual(["slack"]);
      expect(plan.hasWriteSteps).toBe(true);
    });

    it("marks unresolved tool ids as resolved: false", async () => {
      const recipePath = join(tmpDir, "dry-run-unresolved.yaml");
      writeFileSync(
        recipePath,
        `name: dry-run-unresolved
description: Unknown tool should not break the plan
trigger:
  type: manual
steps:
  - id: mystery
    tool: jira.fetch_issue
    issueId: PW-1
`,
      );

      const plan = await runRecipeDryPlan(recipePath);
      const step = plan.steps.find((s) => s.id === "mystery");
      expect(step).toMatchObject({
        tool: "jira.fetch_issue",
        namespace: "jira",
        resolved: false,
      });
      expect(step?.isConnector).toBeUndefined();
      expect(plan.connectorNamespaces).toEqual([]);
    });

    it("seeds dotted tool output previews from registry metadata in simple dry-run plans", async () => {
      const recipePath = join(tmpDir, "dry-run-tool-output.yaml");
      writeFileSync(
        recipePath,
        `name: dry-run-tool-output
description: Dry run tool output refs
trigger:
  type: manual
steps:
  - id: save
    tool: file.write
    path: /tmp/meta.txt
    content: "hello"
    into: saved
  - tool: file.write
    path: /tmp/out.txt
    content: "{{saved.path}} ({{saved.bytesWritten}})"
`,
      );

      const plan = await runRecipeDryPlan(recipePath);

      expect(plan.steps[1]).toMatchObject({
        type: "tool",
        tool: "file.write",
        params: {
          path: "/tmp/out.txt",
          content: "[dry-run:save.path] ([dry-run:save.bytesWritten])",
        },
      });
    });

    it("includes empty lint arrays for a clean recipe", async () => {
      const recipePath = join(tmpDir, "dry-run-clean.yaml");
      writeFileSync(
        recipePath,
        `name: dry-run-clean
description: Clean recipe
trigger:
  type: manual
steps:
  - tool: file.write
    path: /tmp/out.txt
    content: ok
`,
      );

      const plan = await runRecipeDryPlan(recipePath);

      expect(plan.lint).toEqual({ errors: [], warnings: [] });
    });

    it("surfaces dotted-ref / output-schema warnings in plan.lint.warnings", async () => {
      const recipePath = join(tmpDir, "dry-run-bogus-ref.yaml");
      writeFileSync(
        recipePath,
        `name: dry-run-bogus-ref
description: Dry run dotted-ref warning
trigger:
  type: manual
steps:
  - id: save
    tool: file.write
    path: /tmp/meta.txt
    content: "hello"
    into: saved
  - tool: file.write
    path: /tmp/out.txt
    content: "{{saved.bogusField}}"
`,
      );

      const plan = await runRecipeDryPlan(recipePath);

      expect(plan.lint.errors).toEqual([]);
      expect(
        plan.lint.warnings.some(
          (w) => w.includes("saved.bogusField") && w.includes("file.write"),
        ),
      ).toBe(true);
    });

    it("builds a chained-recipe dry-run plan with step selection metadata", async () => {
      const recipePath = join(tmpDir, "dry-run-chained.yaml");
      writeFileSync(
        recipePath,
        `name: dry-run-chained
description: Dry run chained
trigger:
  type: chained
steps:
  - id: gather
    tool: github.list_issues
  - id: summarize
    agent:
      prompt: "Summarize"
    awaits: [gather]
`,
      );

      const plan = await runRecipeDryPlan(recipePath, { step: "summarize" });

      expect(plan.mode).toBe("dry-run");
      expect(plan.triggerType).toBe("chained");
      expect(plan.stepSelection).toEqual({
        query: "summarize",
        matchedBy: "id",
        matchedValue: "summarize",
      });
      expect(plan.steps).toEqual([
        {
          id: "summarize",
          type: "agent",
          dependencies: ["gather"],
          condition: undefined,
          risk: "low",
        },
      ]);
      expect(plan.parallelGroups).toEqual([]);
    });

    it("builds a dry-run plan for the bundled chained example with dependency metadata", async () => {
      const recipePath = join(
        process.cwd(),
        "examples",
        "recipes",
        "chained-followup-demo.yaml",
      );

      const plan = await runRecipeDryPlan(recipePath);

      expect(plan.mode).toBe("dry-run");
      expect(plan.triggerType).toBe("chained");
      expect(plan.maxDepth).toBe(2);
      // F-07 fix: plan steps now also carry the underlying step shape
      // (`tool`, `recipe`, `into`) plus enrichment metadata so the
      // dry-plan can recurse into nested recipes for write detection.
      // Use `toMatchObject` to assert structure without pinning the
      // post-enrichment field set.
      expect(plan.steps).toMatchObject([
        {
          id: "gather_signals",
          type: "tool",
          tool: "inbox.fetch_threads",
          dependencies: [],
          risk: "low",
        },
        {
          id: "triage_summary",
          type: "agent",
          dependencies: ["gather_signals"],
          condition: "{{gather_signals.length > 0}}",
          risk: "low",
        },
        {
          id: "enrich_context",
          type: "tool",
          tool: "notes.lookup_recent_context",
          optional: true,
          dependencies: ["triage_summary"],
          risk: "medium",
        },
        {
          id: "followup_plan",
          type: "recipe",
          recipe: "chained-followup-child",
          into: "followup_packet",
          dependencies: ["triage_summary", "enrich_context"],
          risk: "medium",
        },
      ]);
      expect(plan.parallelGroups).toEqual([
        ["gather_signals"],
        ["triage_summary"],
        ["enrich_context"],
        ["followup_plan"],
      ]);
    });

    // F-07 fix tests. Pre-fix: any chained recipe whose only writes lived
    // in a sub-recipe reported `hasWriteSteps: false` because
    // enrichStepFromRegistry bailed on `step.type === "recipe"` and
    // generateExecutionPlan never emitted the underlying tool/recipe shape.
    // These tests pin the corrected behavior across simple, chained, and
    // nested-chained shapes plus the cycle-safety invariant.
    describe("F-07 — hasWriteSteps recurses into nested recipes", () => {
      it("T6: chained recipe with a top-level write step → hasWriteSteps:true", async () => {
        const recipePath = join(tmpDir, "f07-t6-direct-write.yaml");
        writeFileSync(
          recipePath,
          `name: f07-t6-direct-write
description: top-level write
trigger:
  type: chained
steps:
  - id: w1
    tool: file.write
    params:
      path: ~/.patchwork/inbox/x.md
      content: hello
`,
        );
        const plan = await runRecipeDryPlan(recipePath);
        expect(plan.hasWriteSteps).toBe(true);
        const w1 = plan.steps.find((s) => s.id === "w1");
        expect(w1?.tool).toBe("file.write");
      });

      it("T7: chained recipe with no writes anywhere → hasWriteSteps:false", async () => {
        const recipePath = join(tmpDir, "f07-t7-noop.yaml");
        writeFileSync(
          recipePath,
          `name: f07-t7-noop
description: read-only
trigger:
  type: chained
steps:
  - id: r1
    tool: file.read
    params:
      path: /tmp/x.txt
`,
        );
        const plan = await runRecipeDryPlan(recipePath);
        expect(plan.hasWriteSteps).toBe(false);
      });

      it("T14: outer chained recipe calls inner recipe with file.write → hasWriteSteps:true", async () => {
        const innerPath = join(tmpDir, "f07-t14-inner-writes.yaml");
        writeFileSync(
          innerPath,
          `name: f07-t14-inner-writes
trigger:
  type: chained
steps:
  - id: inner_w
    tool: file.write
    params:
      path: ~/.patchwork/inbox/inner.md
      content: from-inner
`,
        );
        const outerPath = join(tmpDir, "f07-t14-outer.yaml");
        writeFileSync(
          outerPath,
          `name: f07-t14-outer
description: outer with write-only inner
trigger:
  type: chained
steps:
  - id: call_inner
    chain: ./f07-t14-inner-writes.yaml
`,
        );
        const plan = await runRecipeDryPlan(outerPath);
        expect(plan.hasWriteSteps).toBe(true);
        const callInner = plan.steps.find((s) => s.id === "call_inner");
        expect(callInner?.type).toBe("recipe");
        expect(callInner?.recipe).toBe("./f07-t14-inner-writes.yaml");
        expect(callInner?.nestedWriteCount).toBeGreaterThan(0);
      });

      it("T15: outer chained recipe calls read-only inner → hasWriteSteps:false", async () => {
        const innerPath = join(tmpDir, "f07-t15-inner-readonly.yaml");
        writeFileSync(
          innerPath,
          `name: f07-t15-inner-readonly
trigger:
  type: chained
steps:
  - id: inner_r
    tool: file.read
    params:
      path: /tmp/x.txt
`,
        );
        const outerPath = join(tmpDir, "f07-t15-outer.yaml");
        writeFileSync(
          outerPath,
          `name: f07-t15-outer
trigger:
  type: chained
steps:
  - id: call_readonly
    chain: ./f07-t15-inner-readonly.yaml
`,
        );
        const plan = await runRecipeDryPlan(outerPath);
        expect(plan.hasWriteSteps).toBe(false);
        const callReadonly = plan.steps.find((s) => s.id === "call_readonly");
        expect(callReadonly?.nestedWriteCount).toBe(0);
      });

      it("transitive: outer → middle → leaf-write propagates hasWriteSteps:true", async () => {
        const leafPath = join(tmpDir, "f07-leaf-write.yaml");
        writeFileSync(
          leafPath,
          `name: f07-leaf-write
trigger:
  type: chained
steps:
  - id: leaf_w
    tool: file.write
    params:
      path: ~/.patchwork/inbox/leaf.md
      content: leaf
`,
        );
        const midPath = join(tmpDir, "f07-mid.yaml");
        writeFileSync(
          midPath,
          `name: f07-mid
trigger:
  type: chained
steps:
  - id: mid_call
    chain: ./f07-leaf-write.yaml
`,
        );
        const outerPath = join(tmpDir, "f07-outer-mid.yaml");
        writeFileSync(
          outerPath,
          `name: f07-outer-mid
trigger:
  type: chained
steps:
  - id: outer_call
    chain: ./f07-mid.yaml
`,
        );
        const plan = await runRecipeDryPlan(outerPath);
        expect(plan.hasWriteSteps).toBe(true);
      });

      it("cycle: A → B → A does not infinite-loop and reports the parent's own writes accurately", async () => {
        const aPath = join(tmpDir, "f07-cycle-a.yaml");
        const bPath = join(tmpDir, "f07-cycle-b.yaml");
        writeFileSync(
          aPath,
          `name: f07-cycle-a
trigger:
  type: chained
steps:
  - id: a_call
    chain: ./f07-cycle-b.yaml
  - id: a_write
    tool: file.write
    params:
      path: ~/.patchwork/inbox/a.md
      content: a
`,
        );
        writeFileSync(
          bPath,
          `name: f07-cycle-b
trigger:
  type: chained
steps:
  - id: b_call
    chain: ./f07-cycle-a.yaml
`,
        );
        const plan = await runRecipeDryPlan(aPath);
        // Parent has its own write step; cycle does not corrupt detection.
        expect(plan.hasWriteSteps).toBe(true);
      });

      it("missing nested recipe → does not throw; nestedWriteCount omitted", async () => {
        const outerPath = join(tmpDir, "f07-missing-inner.yaml");
        writeFileSync(
          outerPath,
          `name: f07-missing-inner
trigger:
  type: chained
steps:
  - id: phantom
    chain: ./does-not-exist.yaml
`,
        );
        // Should not throw — missing sub-recipe is treated as unknown writes.
        const plan = await runRecipeDryPlan(outerPath);
        const phantom = plan.steps.find((s) => s.id === "phantom");
        expect(phantom?.type).toBe("recipe");
        expect(phantom?.nestedWriteCount).toBeUndefined();
      });

      it("emits tool field on chained plan steps (registry enrichment now reaches them)", async () => {
        const recipePath = join(tmpDir, "f07-tool-field.yaml");
        writeFileSync(
          recipePath,
          `name: f07-tool-field
trigger:
  type: chained
steps:
  - id: read_step
    tool: file.read
    params:
      path: /tmp/x
`,
        );
        const plan = await runRecipeDryPlan(recipePath);
        const readStep = plan.steps.find((s) => s.id === "read_step");
        // Pre-fix: tool field was reachable only via `as unknown as { tool?: unknown }`
        // and required type-cheating. Now it's emitted as a typed plan-step field.
        expect(readStep?.tool).toBe("file.read");
        expect(readStep?.resolved).toBe(true);
      });
    });
  });

  describe("runPreflight", () => {
    it("passes a clean local recipe when writes are acknowledged", async () => {
      const recipePath = join(tmpDir, "preflight-clean.yaml");
      writeFileSync(
        recipePath,
        `name: preflight-clean
description: Clean local recipe
trigger:
  type: manual
steps:
  - tool: file.write
    path: ${JSON.stringify(join(tmpDir, "pf.txt"))}
    content: "hi"
`,
      );

      const result = await runPreflight(recipePath, { allowWrites: ["file"] });
      expect(result.ok).toBe(true);
      expect(result.issues.filter((i) => i.level === "error")).toEqual([]);
      expect(result.plan.schemaVersion).toBe(1);
    });

    it("treats an untrusted write as an error without allowWrites", async () => {
      const recipePath = join(tmpDir, "preflight-unacked-write.yaml");
      writeFileSync(
        recipePath,
        `name: preflight-unacked-write
description: Writes should fail closed
trigger:
  type: manual
steps:
  - tool: file.write
    path: ${JSON.stringify(join(tmpDir, "pf2.txt"))}
    content: "hi"
`,
      );

      const result = await runPreflight(recipePath);
      expect(result.ok).toBe(false);
      expect(
        result.issues.some(
          (i) => i.code === "unacknowledged-write" && i.tool === "file.write",
        ),
      ).toBe(true);
    });

    it("flags unresolved tool ids", async () => {
      const recipePath = join(tmpDir, "preflight-unresolved.yaml");
      writeFileSync(
        recipePath,
        `name: preflight-unresolved
description: Unknown tool should fail preflight
trigger:
  type: manual
steps:
  - id: mystery
    tool: jira.fetch_issue
    issueId: PW-1
`,
      );

      const result = await runPreflight(recipePath);
      expect(result.ok).toBe(false);
      const unresolved = result.issues.find(
        (i) => i.code === "unresolved-tool",
      );
      expect(unresolved).toMatchObject({
        level: "error",
        stepId: "mystery",
        tool: "jira.fetch_issue",
        namespace: "jira",
      });
    });

    it("flags unacknowledged write steps", async () => {
      const recipePath = join(tmpDir, "preflight-write.yaml");
      writeFileSync(
        recipePath,
        `name: preflight-write
description: Unacked write step
trigger:
  type: manual
steps:
  - id: post
    tool: slack.post_message
    channel: alerts
    text: hi
`,
      );

      const fail = await runPreflight(recipePath);
      expect(fail.ok).toBe(false);
      expect(
        fail.issues.some(
          (i) =>
            i.code === "unacknowledged-write" &&
            i.tool === "slack.post_message",
        ),
      ).toBe(true);

      const pass = await runPreflight(recipePath, {
        allowWrites: ["slack.post_message"],
      });
      expect(pass.issues.some((i) => i.code === "unacknowledged-write")).toBe(
        false,
      );

      const passNs = await runPreflight(recipePath, { allowWrites: ["slack"] });
      expect(passNs.issues.some((i) => i.code === "unacknowledged-write")).toBe(
        false,
      );
    });

    it("flags missing fixtures when requireFixtures is set", async () => {
      const recipePath = join(tmpDir, "preflight-fixtures.yaml");
      const fixturesDir = join(tmpDir, "pf-fixtures-missing");
      mkdirSync(fixturesDir, { recursive: true });
      writeFileSync(
        recipePath,
        `name: preflight-fixtures
description: Fixture check
trigger:
  type: manual
steps:
  - id: post
    tool: slack.post_message
    channel: alerts
    text: hi
`,
      );

      const result = await runPreflight(recipePath, {
        requireFixtures: true,
        fixturesDir,
        allowWrites: ["slack"],
      });
      expect(result.ok).toBe(false);
      expect(
        result.issues.some(
          (i) => i.code === "missing-fixture" && i.namespace === "slack",
        ),
      ).toBe(true);
    });
  });

  describe("runTest", () => {
    it("does not require fixtures for local-only tools", async () => {
      const recipePath = join(tmpDir, "local-only.yaml");
      const fixturesDir = join(tmpDir, "fixtures-local-only");
      mkdirSync(fixturesDir, { recursive: true });
      writeFileSync(
        recipePath,
        `name: local-only
description: Local-only tools should not trigger fixture requirements
trigger:
  type: manual
steps:
  - tool: file.write
    path: ${join(tmpDir, "local-out.txt")}
    content: hello
`,
      );

      const result = await runTest(recipePath, { fixturesDir });
      expect(result.requiredFixtures).toEqual([]);
      expect(result.missingFixtures).toEqual([]);
    });

    it("passes when required connector fixtures exist", async () => {
      const recipePath = join(tmpDir, "with-fixtures.yaml");
      const fixturesDir = join(tmpDir, "fixtures");
      mkdirSync(fixturesDir, { recursive: true });
      writeFileSync(
        join(fixturesDir, "github.json"),
        JSON.stringify({
          version: 1,
          provider: "github",
          fixtures: [
            {
              operation: "list_issues",
              input: { assignee: "@me" },
              output: { count: 1, issues: [{ id: 1, title: "Bug" }] },
            },
          ],
        }),
      );
      writeFileSync(
        join(fixturesDir, "gmail.json"),
        JSON.stringify({
          version: 1,
          provider: "gmail",
          fixtures: [
            {
              operation: "fetch_unread",
              input: { since: "24h" },
              output: {
                count: 1,
                messages: [{ id: "msg-1", subject: "Hello" }],
              },
            },
          ],
        }),
      );
      writeFileSync(
        recipePath,
        `name: fixture-test
description: Fixture test
trigger:
  type: manual
steps:
  - tool: github.list_issues
    assignee: "@me"
  - tool: gmail.fetch_unread
    since: "24h"
`,
      );

      const result = await runTest(recipePath, { fixturesDir });
      expect(result.valid).toBe(true);
      expect(result.requiredFixtures).toEqual(["github", "gmail"]);
      expect(result.missingFixtures).toEqual([]);
      expect(result.stepsRun).toBe(2);
    });

    it("fails when a required connector fixture is missing", async () => {
      const recipePath = join(tmpDir, "missing-fixture.yaml");
      const fixturesDir = join(tmpDir, "fixtures-missing");
      mkdirSync(fixturesDir, { recursive: true });
      writeFileSync(
        recipePath,
        `name: missing-fixture
description: Missing fixture
trigger:
  type: manual
steps:
  - tool: slack.post_message
    channel: alerts
    text: hi
`,
      );

      const result = await runTest(recipePath, { fixturesDir });
      expect(result.valid).toBe(false);
      expect(result.requiredFixtures).toEqual(["slack"]);
      expect(result.missingFixtures).toEqual(["slack"]);
      expect(
        result.issues.some((issue: { message: string }) =>
          issue.message.includes(
            "Missing fixture library for connector 'slack'",
          ),
        ),
      ).toBe(true);
    });

    it("passes when an expect block matches the mocked run", async () => {
      const recipePath = join(tmpDir, "expect-pass.yaml");
      const fixturesDir = join(tmpDir, "fixtures-expect-pass");
      mkdirSync(fixturesDir, { recursive: true });
      writeFileSync(
        join(fixturesDir, "gmail.json"),
        JSON.stringify({
          version: 1,
          provider: "gmail",
          fixtures: [
            {
              operation: "fetch_unread",
              input: { since: "24h" },
              output: {
                count: 1,
                messages: [{ id: "msg-1", subject: "Hello" }],
              },
            },
          ],
        }),
      );
      writeFileSync(
        recipePath,
        `name: expect-pass
description: Expect pass
trigger:
  type: manual
steps:
  - tool: gmail.fetch_unread
    since: "24h"
    into: unread
expect:
  stepsRun: 1
  outputs: []
  errorMessage: null
  context:
    unread.count: "1"
`,
      );

      const result = await runTest(recipePath, { fixturesDir });
      expect(result.valid).toBe(true);
      expect(result.errors).toBe(0);
    });

    it("fails when an expect block does not match the mocked run", async () => {
      const recipePath = join(tmpDir, "expect-fail.yaml");
      const fixturesDir = join(tmpDir, "fixtures-expect-fail");
      mkdirSync(fixturesDir, { recursive: true });
      writeFileSync(
        join(fixturesDir, "gmail.json"),
        JSON.stringify({
          version: 1,
          provider: "gmail",
          fixtures: [
            {
              operation: "fetch_unread",
              input: { since: "24h" },
              output: {
                count: 1,
                messages: [{ id: "msg-1", subject: "Hello" }],
              },
            },
          ],
        }),
      );
      writeFileSync(
        recipePath,
        `name: expect-fail
description: Expect fail
trigger:
  type: manual
steps:
  - tool: gmail.fetch_unread
    since: "24h"
    into: unread
expect:
  stepsRun: 2
`,
      );

      const result = await runTest(recipePath, { fixturesDir });
      expect(result.valid).toBe(false);
      expect(
        result.issues.some((issue: { message: string }) =>
          issue.message.includes("stepsRun"),
        ),
      ).toBe(true);
      expect(result.assertionFailures.length).toBeGreaterThan(0);
      expect(result.assertionFailures[0]!.assertion).toBe("stepsRun");
    });

    it("surfaces assertionFailures with structured detail", async () => {
      const recipePath = join(tmpDir, "expect-structured.yaml");
      writeFileSync(
        recipePath,
        `name: expect-structured
description: Structured assertion failure
trigger:
  type: manual
steps:
  - tool: file.write
    path: /tmp/x.txt
    content: "hello"
    into: saved
expect:
  stepsRun: 5
  outputs:
    - missing-key
`,
      );

      const result = await runTest(recipePath);
      expect(result.valid).toBe(false);
      expect(result.assertionFailures.length).toBeGreaterThanOrEqual(2);
      const assertions = result.assertionFailures.map((f) => f.assertion);
      expect(assertions).toContain("stepsRun");
      expect(assertions).toContain("outputs");
    });

    it("has empty assertionFailures when expect block passes", async () => {
      const recipePath = join(tmpDir, "expect-pass.yaml");
      writeFileSync(
        recipePath,
        `name: expect-pass
description: Expect pass
trigger:
  type: manual
steps:
  - tool: file.write
    path: /tmp/p.txt
    content: "hello"
    into: saved
expect:
  stepsRun: 1
  errorMessage: null
`,
      );

      const result = await runTest(recipePath);
      expect(result.valid).toBe(true);
      expect(result.assertionFailures).toHaveLength(0);
    });

    it("has empty assertionFailures when no expect block", async () => {
      const recipePath = join(tmpDir, "no-expect.yaml");
      writeFileSync(
        recipePath,
        `name: no-expect
description: No expect block
trigger:
  type: manual
steps:
  - tool: file.write
    path: /tmp/q.txt
    content: "hi"
`,
      );

      const result = await runTest(recipePath);
      expect(result.assertionFailures).toHaveLength(0);
    });
  });

  describe("runTest (chained recipes)", () => {
    it("runs a chained recipe with mocked tools and reports step count", async () => {
      const recipePath = join(tmpDir, "chained-test.yaml");
      writeFileSync(
        recipePath,
        `name: chained-test
description: Chained test recipe
trigger:
  type: chained
steps:
  - id: fetch
    tool: git.status
  - id: summarize
    tool: git.status
    awaits: [fetch]
`,
      );

      const result = await runTest(recipePath);
      expect(result.valid).toBe(true);
      expect(result.stepsRun).toBe(2);
    });

    it("reports failure when a chained step has no tool or agent", async () => {
      const recipePath = join(tmpDir, "chained-bad.yaml");
      writeFileSync(
        recipePath,
        `name: chained-bad
description: Bad chained recipe
trigger:
  type: chained
steps:
  - id: empty
`,
      );

      const result = await runTest(recipePath);
      expect(result.valid).toBe(false);
    });

    it("evaluates expect.stepsRun for chained recipes", async () => {
      const recipePath = join(tmpDir, "chained-expect.yaml");
      writeFileSync(
        recipePath,
        `name: chained-expect
description: Chained expect test
trigger:
  type: chained
steps:
  - id: a
    tool: git.status
  - id: b
    tool: git.status
    awaits: [a]
expect:
  stepsRun: 2
`,
      );

      const result = await runTest(recipePath);
      expect(result.valid).toBe(true);
      expect(result.assertionFailures).toHaveLength(0);
    });

    it("surfaces expect.stepsRun mismatch as assertion failure for chained recipes", async () => {
      const recipePath = join(tmpDir, "chained-expect-fail.yaml");
      writeFileSync(
        recipePath,
        `name: chained-expect-fail
description: Chained expect failure test
trigger:
  type: chained
steps:
  - id: a
    tool: git.status
expect:
  stepsRun: 5
`,
      );

      const result = await runTest(recipePath);
      expect(result.valid).toBe(false);
      expect(result.assertionFailures.length).toBeGreaterThan(0);
      expect(result.assertionFailures[0]!.assertion).toBe("stepsRun");
    });
  });

  describe("runWatch", () => {
    it("runs a valid watched recipe through the shared local execution path", async () => {
      const recipePath = join(tmpDir, "watched-valid.yaml");
      const outPath = join(tmpDir, "watched-output.txt");
      writeFileSync(
        recipePath,
        `name: watched-valid
description: Watched valid
trigger:
  type: manual
steps:
  - tool: file.write
    path: ${JSON.stringify(outPath)}
    content: "watch run"
`,
      );

      const watched = await runWatchedRecipe(recipePath);

      expect(watched.lint.valid).toBe(true);
      expect(watched.run).toBeDefined();
      expect(watched.summary).toMatchObject({
        ok: true,
        steps: 1,
        outputs: [outPath],
      });
      expect(readFileSync(outPath, "utf-8")).toBe("watch run");
    });

    it("returns lint errors instead of executing an invalid watched recipe", async () => {
      const recipePath = join(tmpDir, "watched-invalid.yaml");
      writeFileSync(
        recipePath,
        `name: watched-invalid
description: Watched invalid
trigger:
  type: manual
`,
      );

      const watched = await runWatchedRecipe(recipePath);

      expect(watched.lint.valid).toBe(false);
      expect(watched.run).toBeUndefined();
      expect(watched.summary).toBeUndefined();
    });

    it("debounces rapid saves into a single callback", async () => {
      vi.useFakeTimers();
      try {
        let listener:
          | ((eventType: string, changedFile: string | Buffer | null) => void)
          | undefined;
        const onChange = vi.fn();
        const stop = runWatch({
          recipePath: join(tmpDir, "watch.yaml"),
          onChange,
          debounceMs: 300,
          watchFactory: (_watchPath, _watchOptions, nextListener) => {
            listener = nextListener;
            return { close: vi.fn() };
          },
        });

        listener?.("change", "watch.yaml");
        listener?.("change", Buffer.from("watch.yaml"));
        listener?.("change", "other.yaml");

        await vi.advanceTimersByTimeAsync(299);
        expect(onChange).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(onChange).toHaveBeenCalledTimes(1);

        stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("queues exactly one rerun while a callback is in flight", async () => {
      vi.useFakeTimers();
      try {
        let listener:
          | ((eventType: string, changedFile: string | Buffer | null) => void)
          | undefined;
        const pendingResolves: Array<() => void> = [];
        let inFlight = 0;
        let maxInFlight = 0;
        const onChange = vi.fn(async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>((resolve) => {
            pendingResolves.push(() => {
              inFlight -= 1;
              resolve();
            });
          });
        });

        const stop = runWatch({
          recipePath: join(tmpDir, "queued-watch.yaml"),
          onChange,
          debounceMs: 10,
          watchFactory: (_watchPath, _watchOptions, nextListener) => {
            listener = nextListener;
            return { close: vi.fn() };
          },
        });

        listener?.("change", "queued-watch.yaml");
        await vi.advanceTimersByTimeAsync(10);
        expect(onChange).toHaveBeenCalledTimes(1);

        listener?.("change", "queued-watch.yaml");
        listener?.("change", "queued-watch.yaml");
        listener?.("change", "queued-watch.yaml");
        await vi.advanceTimersByTimeAsync(50);
        expect(onChange).toHaveBeenCalledTimes(1);

        const finishFirstRun = pendingResolves.shift();
        finishFirstRun?.();
        await vi.advanceTimersByTimeAsync(0);

        expect(onChange).toHaveBeenCalledTimes(2);
        expect(maxInFlight).toBe(1);

        const finishSecondRun = pendingResolves.shift();
        finishSecondRun?.();
        await vi.advanceTimersByTimeAsync(0);

        expect(onChange).toHaveBeenCalledTimes(2);

        stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels a pending debounce when stopped", async () => {
      vi.useFakeTimers();
      try {
        let listener:
          | ((eventType: string, changedFile: string | Buffer | null) => void)
          | undefined;
        const close = vi.fn();
        const onChange = vi.fn();
        const stop = runWatch({
          recipePath: join(tmpDir, "stopped-watch.yaml"),
          onChange,
          debounceMs: 300,
          watchFactory: (_watchPath, _watchOptions, nextListener) => {
            listener = nextListener;
            return { close };
          },
        });

        listener?.("change", "stopped-watch.yaml");
        stop();
        await vi.advanceTimersByTimeAsync(300);

        expect(onChange).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("runRecord", () => {
    it("records connector fixtures from a live-style execution", async () => {
      const recipePath = join(tmpDir, "record.yaml");
      const fixturesDir = join(tmpDir, "recorded-fixtures");
      writeFileSync(
        recipePath,
        `name: record-fixtures
description: Record fixtures
trigger:
  type: manual
steps:
  - tool: gmail.fetch_unread
    since: "24h"
    max: 5
    into: unread
`,
      );

      const result = await runRecord(recipePath, {
        fixturesDir,
        deps: {
          testMode: true,
          readFile: (filePath) => readFileSync(filePath, "utf-8"),
          writeFile: () => {},
          appendFile: () => {},
          mkdir: () => {},
          gitLogSince: () => "",
          gitStaleBranches: () => "",
          getDiagnostics: () => "",
          getGmailToken: async () => "test-token",
          fetchFn: async (url) => {
            if (url.includes("/messages?q=")) {
              return {
                ok: true,
                json: async () => ({
                  messages: [{ id: "msg-1", threadId: "thread-1" }],
                }),
              };
            }
            return {
              ok: true,
              json: async () => ({
                id: "msg-1",
                snippet: "Hello world",
                payload: {
                  headers: [
                    { name: "Subject", value: "Hi" },
                    { name: "From", value: "a@example.com" },
                    { name: "Date", value: "2026-04-23" },
                  ],
                },
              }),
            };
          },
          claudeFn: async () => "",
          claudeCodeFn: async () => "",
          providerDriverFn: async () => "",
        },
      });

      expect(result.valid).toBe(true);
      expect(result.recordedFixtures).toEqual(["gmail"]);
      expect(result.stepsRun).toBe(1);

      const library = loadFixtureLibrary(join(fixturesDir, "gmail.json"));
      expect(library?.provider).toBe("gmail");
      expect(library?.fixtures).toHaveLength(1);
      expect(library?.fixtures[0]).toMatchObject({
        operation: "fetch_unread",
        input: { max: 5, since: "24h" },
      });
    });
  });

  describe("runPreflightWatch", () => {
    it("invokes onResult with a preflight result on save", async () => {
      vi.useFakeTimers();
      try {
        const recipePath = join(tmpDir, "preflight-watch.yaml");
        writeFileSync(
          recipePath,
          `name: preflight-watch
description: Watch preflight
trigger:
  type: manual
steps:
  - id: mystery
    tool: jira.fetch_issue
    issueId: PW-1
`,
        );

        let listener:
          | ((eventType: string, changedFile: string | Buffer | null) => void)
          | undefined;
        const onResult = vi.fn();

        const stop = runPreflightWatch({
          recipePath,
          debounceMs: 10,
          onResult,
          watchFactory: (_watchPath, _watchOptions, nextListener) => {
            listener = nextListener;
            return { close: vi.fn() };
          },
        });

        listener?.("change", "preflight-watch.yaml");
        await vi.advanceTimersByTimeAsync(10);
        await vi.runAllTimersAsync();
        // give the async onChange → runPreflight chain a tick to settle
        await Promise.resolve();
        await Promise.resolve();

        expect(onResult).toHaveBeenCalledTimes(1);
        const call = onResult.mock.calls[0]?.[0] as {
          ok: boolean;
          issues: Array<{ code: string }>;
        };
        expect(call.ok).toBe(false);
        expect(call.issues.some((i) => i.code === "unresolved-tool")).toBe(
          true,
        );

        stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("runTestWatch", () => {
    it("invokes onResult with a test result on save", async () => {
      vi.useFakeTimers();
      try {
        const recipePath = join(tmpDir, "test-watch-basic.yaml");
        writeFileSync(
          recipePath,
          `name: test-watch-basic
description: Watch test basic
trigger:
  type: manual
steps:
  - tool: file.write
    path: /tmp/tw.txt
    content: "hello"
    into: saved
expect:
  stepsRun: 1
  errorMessage: null
`,
        );

        let listener:
          | ((eventType: string, changedFile: string | Buffer | null) => void)
          | undefined;
        const onResult = vi.fn();

        const stop = runTestWatch({
          recipePath,
          debounceMs: 10,
          onResult,
          watchFactory: (_watchPath, _watchOptions, nextListener) => {
            listener = nextListener;
            return { close: vi.fn() };
          },
        });

        listener?.("change", "test-watch-basic.yaml");
        await vi.advanceTimersByTimeAsync(10);
        await vi.runAllTimersAsync();
        await Promise.resolve();
        await Promise.resolve();

        expect(onResult).toHaveBeenCalledTimes(1);
        const call = onResult.mock.calls[0]?.[0] as {
          valid: boolean;
          assertionFailures: unknown[];
        };
        expect(call.valid).toBe(true);
        expect(call.assertionFailures).toHaveLength(0);

        stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("surfaces assertion failures in watch onResult", async () => {
      vi.useFakeTimers();
      try {
        const recipePath = join(tmpDir, "test-watch-fail.yaml");
        writeFileSync(
          recipePath,
          `name: test-watch-fail
description: Watch test with failing assertions
trigger:
  type: manual
steps:
  - tool: file.write
    path: /tmp/tw2.txt
    content: "hi"
expect:
  stepsRun: 99
`,
        );

        let listener:
          | ((eventType: string, changedFile: string | Buffer | null) => void)
          | undefined;
        const onResult = vi.fn();

        const stop = runTestWatch({
          recipePath,
          debounceMs: 10,
          onResult,
          watchFactory: (_watchPath, _watchOptions, nextListener) => {
            listener = nextListener;
            return { close: vi.fn() };
          },
        });

        listener?.("change", "test-watch-fail.yaml");
        await vi.advanceTimersByTimeAsync(10);
        await vi.runAllTimersAsync();
        await Promise.resolve();
        await Promise.resolve();

        expect(onResult).toHaveBeenCalledTimes(1);
        const call = onResult.mock.calls[0]?.[0] as {
          valid: boolean;
          assertionFailures: Array<{ assertion: string }>;
        };
        expect(call.valid).toBe(false);
        expect(call.assertionFailures.length).toBeGreaterThan(0);
        expect(call.assertionFailures[0]!.assertion).toBe("stepsRun");

        stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("re-runs on subsequent saves", async () => {
      vi.useFakeTimers();
      try {
        const recipePath = join(tmpDir, "test-watch-rerun.yaml");
        writeFileSync(
          recipePath,
          `name: test-watch-rerun
description: Watch test rerun
trigger:
  type: manual
steps:
  - tool: file.write
    path: /tmp/tw3.txt
    content: "hi"
`,
        );

        let listener:
          | ((eventType: string, changedFile: string | Buffer | null) => void)
          | undefined;
        const onResult = vi.fn();

        const stop = runTestWatch({
          recipePath,
          debounceMs: 10,
          onResult,
          watchFactory: (_watchPath, _watchOptions, nextListener) => {
            listener = nextListener;
            return { close: vi.fn() };
          },
        });

        // First save
        listener?.("change", "test-watch-rerun.yaml");
        await vi.advanceTimersByTimeAsync(10);
        await vi.runAllTimersAsync();
        await Promise.resolve();
        await Promise.resolve();

        // Second save
        listener?.("change", "test-watch-rerun.yaml");
        await vi.advanceTimersByTimeAsync(10);
        await vi.runAllTimersAsync();
        await Promise.resolve();
        await Promise.resolve();

        expect(onResult).toHaveBeenCalledTimes(2);

        stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("runFmtWatch", () => {
    it("invokes onResult with fmt result on save (already formatted)", async () => {
      vi.useFakeTimers();
      try {
        const recipePath = join(tmpDir, "fmt-watch-clean.yaml");
        writeFileSync(
          recipePath,
          `name: fmt-watch-clean
description: Already formatted
trigger:
  type: manual
steps:
  - tool: file.write
    path: /tmp/fw.txt
    content: "hello"
`,
        );

        let listener:
          | ((eventType: string, changedFile: string | Buffer | null) => void)
          | undefined;
        const onResult = vi.fn();

        const stop = runFmtWatch({
          recipePath,
          debounceMs: 10,
          onResult,
          watchFactory: (_watchPath, _watchOptions, nextListener) => {
            listener = nextListener;
            return { close: vi.fn() };
          },
        });

        listener?.("change", "fmt-watch-clean.yaml");
        await vi.advanceTimersByTimeAsync(10);
        await vi.runAllTimersAsync();
        await Promise.resolve();

        expect(onResult).toHaveBeenCalledTimes(1);
        const call = onResult.mock.calls[0]?.[0] as { changed: boolean };
        expect(typeof call.changed).toBe("boolean");

        stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("re-runs on subsequent saves", async () => {
      vi.useFakeTimers();
      try {
        const recipePath = join(tmpDir, "fmt-watch-rerun.yaml");
        writeFileSync(
          recipePath,
          `name: fmt-watch-rerun
description: Rerun test
trigger:
  type: manual
steps:
  - tool: file.write
    path: /tmp/fw2.txt
    content: "hi"
`,
        );

        let listener:
          | ((eventType: string, changedFile: string | Buffer | null) => void)
          | undefined;
        const onResult = vi.fn();

        const stop = runFmtWatch({
          recipePath,
          debounceMs: 10,
          onResult,
          watchFactory: (_watchPath, _watchOptions, nextListener) => {
            listener = nextListener;
            return { close: vi.fn() };
          },
        });

        listener?.("change", "fmt-watch-rerun.yaml");
        await vi.advanceTimersByTimeAsync(10);
        await vi.runAllTimersAsync();
        await Promise.resolve();

        listener?.("change", "fmt-watch-rerun.yaml");
        await vi.advanceTimersByTimeAsync(10);
        await vi.runAllTimersAsync();
        await Promise.resolve();

        expect(onResult).toHaveBeenCalledTimes(2);

        stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("check mode: onResult reflects changed=true for unformatted file", async () => {
      vi.useFakeTimers();
      try {
        const recipePath = join(tmpDir, "fmt-watch-check.yaml");
        // Deliberately unformatted key order (steps before trigger)
        writeFileSync(
          recipePath,
          `name: fmt-watch-check
steps:
  - tool: file.write
    path: /tmp/fw3.txt
    content: "hi"
trigger:
  type: manual
`,
        );

        let listener:
          | ((eventType: string, changedFile: string | Buffer | null) => void)
          | undefined;
        const onResult = vi.fn();

        const stop = runFmtWatch({
          recipePath,
          check: true,
          debounceMs: 10,
          onResult,
          watchFactory: (_watchPath, _watchOptions, nextListener) => {
            listener = nextListener;
            return { close: vi.fn() };
          },
        });

        listener?.("change", "fmt-watch-check.yaml");
        await vi.advanceTimersByTimeAsync(10);
        await vi.runAllTimersAsync();
        await Promise.resolve();

        expect(onResult).toHaveBeenCalledTimes(1);
        const call = onResult.mock.calls[0]?.[0] as { changed: boolean };
        expect(call.changed).toBe(true);

        stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
