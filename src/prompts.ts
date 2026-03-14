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

  "set-effort": ({ level = "medium" }) => {
    const validLevels = ["low", "medium", "high"] as const;
    type EffortLevel = typeof validLevels[number];
    const eff: EffortLevel = (validLevels as readonly string[]).includes(level) ? (level as EffortLevel) : "medium";
    const guidance: Record<EffortLevel, string> = {
      low: "Respond concisely. Prefer quick, direct answers without extensive analysis or exhaustive edge-case coverage.",
      medium: "Balance thoroughness with speed. Cover the main cases and explain your reasoning briefly.",
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
