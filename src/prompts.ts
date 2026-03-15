// MCP Prompts — reusable IDE workflow templates surfaced as slash commands
// in Claude Code chat: /mcp__bridge__<name>

export interface McpPromptArgument {
  name: string;
  description: string;
  required?: boolean;
}

export interface McpPrompt {
  name: string;
  description: string;
  arguments?: McpPromptArgument[];
}

export interface PromptMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
}

export interface GetPromptResult {
  description?: string;
  messages: PromptMessage[];
}

// ── Prompt definitions ────────────────────────────────────────────────────────

export const PROMPTS: McpPrompt[] = [
  {
    name: "review-file",
    description:
      "Thorough code review of a file: correctness, style, performance, security, and test coverage gaps.",
    arguments: [
      {
        name: "file",
        description:
          "Workspace-relative or absolute path to the file to review.",
        required: true,
      },
    ],
  },
  {
    name: "explain-diagnostics",
    description:
      "Explain the current diagnostics (errors/warnings) for a file and suggest concrete fixes.",
    arguments: [
      {
        name: "file",
        description:
          "Workspace-relative or absolute path to the file with diagnostics.",
        required: true,
      },
    ],
  },
  {
    name: "generate-tests",
    description:
      "Generate missing unit tests for a file, following the project's existing test conventions.",
    arguments: [
      {
        name: "file",
        description:
          "Workspace-relative or absolute path to the file to generate tests for.",
        required: true,
      },
    ],
  },
  {
    name: "debug-context",
    description:
      "Snapshot the current IDE state — open editors, active diagnostics, and recent terminal output — as debugging context.",
    arguments: [],
  },
  {
    name: "git-review",
    description:
      "Review uncommitted changes (staged + unstaged) against a base branch before committing or opening a PR.",
    arguments: [
      {
        name: "base",
        description: "Base branch or ref to diff against (default: main).",
        required: false,
      },
    ],
  },
  {
    name: "cowork",
    description:
      "Load full IDE context (open files, diagnostics, git status, project info, handoff note) and propose a concrete Cowork action plan. Invoke this before any computer-use task so Claude arrives informed.",
    arguments: [
      {
        name: "task",
        description:
          "Optional task description to focus context gathering (e.g. 'fix all TypeScript errors').",
        required: false,
      },
    ],
  },
  {
    name: "gen-claude-md",
    description:
      "Generate a CLAUDE.md bridge workflow section for this project. Outputs the standard bridge workflow rules and quick-reference table, then writes it into the project's CLAUDE.md.",
    arguments: [],
  },
  {
    name: "set-effort",
    description:
      "Prepend a model-effort instruction to the next task. Use 'low' for quick answers, 'medium' for normal work, 'high' for complex refactors or deep analysis.",
    arguments: [
      {
        name: "level",
        description: "Effort level: low | medium | high (default: medium).",
        required: false,
      },
    ],
  },
];

// ── Prompt template strings ───────────────────────────────────────────────────

const TEMPLATES: Record<
  string,
  (args: Record<string, string>) => GetPromptResult
> = {
  "review-file": ({ file }) => ({
    description: `Code review of ${file}`,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `Please do a thorough code review of \`${file}\`.`,
            "",
            "Cover:",
            "1. **Correctness** — logic bugs, edge cases, error handling",
            "2. **Style & readability** — naming, structure, comments",
            "3. **Performance** — algorithmic issues, unnecessary work",
            "4. **Security** — injection risks, input validation, auth checks",
            "5. **Test coverage** — what's untested or undertested",
            "",
            "Use `getDiagnostics` and `getBufferContent` to read the file before reviewing.",
          ].join("\n"),
        },
      },
    ],
  }),

  "explain-diagnostics": ({ file }) => ({
    description: `Explain diagnostics for ${file}`,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `Call \`getDiagnostics\` for \`${file}\`, then explain each error and warning in plain language.`,
            "",
            "For each diagnostic:",
            "- Quote the relevant code and explain why it's wrong",
            "- Show the corrected code",
            "- Note any related issues that might need attention",
            "",
            "Apply fixes using `editText` or `replaceBlock` after explaining.",
          ].join("\n"),
        },
      },
    ],
  }),

  "generate-tests": ({ file }) => ({
    description: `Generate tests for ${file}`,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `Generate comprehensive unit tests for \`${file}\`.`,
            "",
            "Steps:",
            "1. Read the file with `getBufferContent`",
            "2. Look at existing test files with `findFiles` to understand the project's test conventions",
            "3. Check `getCodeCoverage` if available to identify uncovered paths",
            "4. Write tests covering: happy paths, edge cases, error conditions, and boundary values",
            "",
            "Follow the project's existing testing framework and style exactly.",
          ].join("\n"),
        },
      },
    ],
  }),

  "debug-context": (_args) => ({
    description: "Current IDE debug context",
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            "Collect the current IDE state as debugging context:",
            "",
            "1. Call `getOpenEditors` — list all open files",
            "2. Call `getDiagnostics` for each open file with errors/warnings",
            "3. Call `getTerminalOutput` for any active terminals",
            "4. Call `getGitStatus` to show uncommitted changes",
            "",
            "Summarise what you find and identify the most likely root causes of any problems.",
          ].join("\n"),
        },
      },
    ],
  }),

  cowork: ({ task = "" }) => {
    const taskLine = task ? `\nFocus: **${task}**\n` : "";
    return {
      description: task
        ? `Cowork context — ${task}`
        : "Cowork context — full IDE snapshot",
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "## Step 1 of 2 — Gather IDE context (you are here)",
              "",
              "⚠️  **Important:** Cowork (computer-use) sessions do NOT have access to MCP bridge tools.",
              "This prompt must be run in a regular Claude Code or Claude Desktop chat BEFORE opening Cowork.",
              taskLine,
              "Collect full IDE context:",
              "",
              "1. Call `getHandoffNote` — check for prior session context or an in-progress task",
              "2. Call `getOpenEditors` — list open files and any unsaved changes",
              "3. Call `getDiagnostics` — surface errors and warnings across the workspace",
              "4. Call `getGitStatus` — show staged, unstaged, and untracked changes",
              "5. Call `getProjectInfo` — detect project type, key scripts, and dependencies",
              "",
              "After collecting context:",
              "- Summarise the current workspace state in 3–5 bullet points",
              "- Propose a concrete, step-by-step Cowork action plan",
              "- Call out anything that needs clarification before starting",
              "",
              "## Step 2 of 2 — Hand off to Cowork",
              "",
              "Once the plan is clear, call `setHandoffNote` with a concise summary so the Cowork session",
              "can pick up where you left off. Then open Cowork (Cmd+2 on Mac) and type:",
              "",
              "  /mcp__bridge__cowork",
              "",
              "The Cowork session will read the handoff note and execute the plan using computer-use.",
              "",
              "---",
              "After the tool calls above, end your response with a ready-to-use `setHandoffNote` call",
              "that summarises the task, relevant file paths, and the action plan in 3–5 bullets.",
            ].join("\n"),
          },
        },
      ],
    };
  },

  "set-effort": ({ level = "medium" }) => {
    const validLevels = ["low", "medium", "high"] as const;
    type EffortLevel = (typeof validLevels)[number];
    const eff: EffortLevel = (validLevels as readonly string[]).includes(level)
      ? (level as EffortLevel)
      : "medium";
    const guidance: Record<EffortLevel, string> = {
      low: "Respond concisely. Prefer quick, direct answers without extensive analysis or exhaustive edge-case coverage.",
      medium:
        "Balance thoroughness with speed. Cover the main cases and explain your reasoning briefly.",
      high: "Apply maximum effort. Think step by step, explore edge cases, and produce the most complete and correct result possible.",
    };
    return {
      description: `Effort level set to: ${eff}`,
      messages: [
        {
          role: "user",
          content: {
            type: "text" as const,
            text: `[Effort instruction for this task]\n${guidance[eff]}\n\nPlease acknowledge this effort level and apply it to all subsequent work in this conversation.`,
          },
        },
      ],
    };
  },

  "gen-claude-md": (_args) => ({
    description: "Generate bridge workflow section for CLAUDE.md",
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            "Add the Claude IDE Bridge workflow section to this project's `CLAUDE.md`.",
            "",
            "Steps:",
            "1. Check if `CLAUDE.md` already exists in the workspace root using `findFiles`",
            "2. If it exists, read it with `getBufferContent` to check for an existing `## Claude IDE Bridge` section",
            "3. If the section already exists, report that no changes are needed",
            "4. Otherwise, append the following content to `CLAUDE.md` (or create it if absent):",
            "",
            "---",
            "## Claude IDE Bridge",
            "",
            "The bridge is connected via MCP. Call `getToolCapabilities` at the start of each session to confirm which tools are available and note any that require the VS Code extension.",
            "",
            "### Workflow rules",
            "",
            "- **After editing any file** — call `getDiagnostics` to catch errors introduced by the change",
            "- **Running tests** — use `runTests` instead of shell commands; output streams in real time",
            "- **Git operations** — use bridge git tools (`gitStatus`, `gitAdd`, `gitCommit`, `gitPush`) for structured, auditable operations",
            "- **Debugging** — use `setDebugBreakpoints` → `startDebugging` → `evaluateInDebugger` for interactive debugging",
            "- **Navigating code** — prefer `goToDefinition`, `findReferences`, and `getCallHierarchy` over grep",
            "",
            "### Quick reference",
            "",
            "| Task | Tool |",
            "|---|---|",
            "| Check errors / warnings | `getDiagnostics` |",
            "| Run tests | `runTests` |",
            "| Git status / diff | `gitStatus`, `gitDiff` |",
            "| Stage, commit, push | `gitAdd`, `gitCommit`, `gitPush` |",
            "| Open a pull request | `githubCreatePR` |",
            "| Navigate to definition | `goToDefinition` |",
            "| Find all references | `findReferences` |",
            "| Call hierarchy | `getCallHierarchy` |",
            "| File tree / symbols | `getFileTree`, `getDocumentSymbols` |",
            "| Run a shell command | `runInTerminal`, `getTerminalOutput` |",
            "| Interactive debug | `setDebugBreakpoints`, `startDebugging`, `evaluateInDebugger` |",
            "| Lint / format | `fixAllLintErrors`, `formatDocument` |",
            "| Security audit | `getSecurityAdvisories`, `auditDependencies` |",
            "| Unused code | `detectUnusedCode` |",
            "---",
          ].join("\n"),
        },
      },
    ],
  }),

  "git-review": ({ base = "main" }) => ({
    description: `Review changes vs ${base}`,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `Review all uncommitted changes against \`${base}\` before I commit or open a PR.`,
            "",
            "Steps:",
            `1. Call \`getGitDiff\` to see the full diff vs \`${base}\``,
            "2. Call `getGitStatus` to see staged vs unstaged files",
            "3. Call `getDiagnostics` for each changed file",
            "",
            "Report:",
            "- Any bugs or logic problems introduced",
            "- Style or consistency issues",
            "- Missing tests for new code",
            "- Suggested commit message (conventional-commits format)",
          ].join("\n"),
        },
      },
    ],
  }),
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Retrieve a filled prompt template.
 * Returns null if the name is unknown or a required argument is missing.
 */
export function getPrompt(
  name: string,
  args: Record<string, string>,
): GetPromptResult | null {
  const def = PROMPTS.find((p) => p.name === name);
  if (!def) return null;

  // Validate required arguments
  for (const arg of def.arguments ?? []) {
    if (arg.required && !args[arg.name]) return null;
  }

  const template = TEMPLATES[name];
  if (!template) return null;

  return template(args);
}
