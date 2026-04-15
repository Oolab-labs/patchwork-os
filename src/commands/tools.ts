/**
 * `claude-ide-bridge tools` CLI subcommand.
 *
 * Subcommands:
 *   search <query>  — case-insensitive substring match on name, description, category
 *   list            — all tools grouped by category
 *
 * No bridge connection required — reads static registry at import time.
 */

import { TOOL_CATEGORIES } from "../tools/index.js";

// ---------------------------------------------------------------------------
// Static description map for the most important tools.
// Categories come from TOOL_CATEGORIES; descriptions here are first-sentence
// summaries used by the CLI only (does not affect the MCP searchTools tool).
// ---------------------------------------------------------------------------
export const TOOL_DESCRIPTIONS: Record<string, string> = {
  // git
  getGitStatus:
    "Show working tree status including staged and unstaged changes.",
  getGitDiff: "Show diff for staged, unstaged, or between refs.",
  getGitLog: "Retrieve recent commit history with author and message.",
  gitAdd: "Stage files for the next commit.",
  gitCommit: "Create a git commit with a message.",
  gitPush: "Push the current branch to the remote.",
  gitCheckout: "Checkout an existing branch or create a new one.",
  gitPull: "Pull latest commits from the remote.",
  gitListBranches: "List local and remote branches.",
  gitBlame: "Show per-line authorship for a file.",
  getGitHotspots: "Find change-heavy files using git log history.",
  getSymbolHistory: "Show git blame + log history for a specific symbol.",
  getCommitDetails: "Show full details for a single commit hash.",
  getDiffBetweenRefs: "Diff between two git refs (branches, tags, commits).",
  githubCreatePR: "Open a pull request on GitHub.",
  githubListPRs: "List open pull requests for the repository.",
  githubViewPR: "View details and diff for a pull request.",
  githubListIssues: "List GitHub issues for the repository.",
  githubGetIssue: "Get details for a specific GitHub issue.",
  githubCreateIssue: "Create a new GitHub issue.",
  githubCommentIssue: "Post a comment on a GitHub issue.",
  githubListRuns: "List recent GitHub Actions workflow runs.",
  githubGetRunLogs: "Fetch logs from a GitHub Actions run.",
  githubGetPRDiff: "Get the diff for a pull request.",
  githubPostPRReview: "Post a review comment on a pull request.",
  getPRTemplate: "Generate a pull request description from staged changes.",

  // lsp
  getDiagnostics:
    "Return TypeScript/ESLint/Biome errors and warnings for a file or workspace.",
  watchDiagnostics:
    "Long-poll for diagnostic changes (errors/warnings) in real time.",
  getDocumentSymbols:
    "List all symbols (functions, classes, variables) in a file.",
  goToDefinition: "Navigate to the definition of a symbol.",
  findReferences: "Find all references to a symbol across the workspace.",
  findImplementations:
    "Find all implementations of an interface or abstract method.",
  goToTypeDefinition: "Navigate to the type definition of a symbol.",
  goToDeclaration: "Navigate to the declaration of a symbol.",
  getHover: "Get hover information (type, docs) for a symbol at a position.",
  getCodeActions: "List available code actions (quick fixes) at a position.",
  applyCodeAction: "Apply a code action returned by getCodeActions.",
  previewCodeAction: "Preview the edits a code action would make.",
  refactorPreview: "Preview exact edits a rename or refactor would produce.",
  renameSymbol: "Safely rename a symbol across the workspace.",
  searchWorkspaceSymbols:
    "Find classes, functions, and variables by name pattern.",
  getCallHierarchy: "Show incoming or outgoing call hierarchy for a function.",
  explainSymbol:
    "Composite: hover + definition + refs + type hierarchy in one call.",
  prepareRename: "Check whether a symbol at a position can be renamed.",
  signatureHelp: "Show function signature and parameter info at a call site.",
  refactorAnalyze:
    "Analyze rename/refactor risk (ref count, caller count, risk level).",
  selectionRanges: "Get smart selection expansion ranges for a position.",
  foldingRanges: "Get fold ranges (functions, blocks) for a file.",
  refactorExtractFunction: "Extract a selection into a new named function.",
  getImportTree: "Show the full downstream import dependency chain for a file.",
  getImportedSignatures: "Show signatures of all symbols imported into a file.",
  getDocumentLinks:
    "Find all file references and links embedded in a document.",
  batchGetHover: "Get hover info for up to 10 symbols in a single call.",
  batchGoToDefinition:
    "Go to definition for up to 10 symbols in a single call.",
  batchFindImplementations:
    "Find implementations for up to 10 symbols in a single call.",
  getSemanticTokens: "Get semantic token types and modifiers for a file.",
  getCodeLens: "Get code lens annotations (test run counts, reference counts).",
  getChangeImpact:
    "Blast-radius analysis: diagnostics + reference counts for changed symbols.",
  getTypeHierarchy: "Show supertypes and subtypes for a class or interface.",
  getInlayHints: "Get inline type annotations and parameter names.",
  getHoverAtCursor:
    "Get hover info at the current cursor position in the active editor.",
  getTypeSignature: "Get the type signature for a symbol.",
  jumpToFirstError: "Navigate the editor to the first error in the workspace.",
  navigateToSymbolByName:
    "Jump to a symbol by name using LSP or ctags fallback.",

  // editor
  getOpenEditors: "List all files currently open in the editor.",
  getCurrentSelection: "Get the current text selection in the active editor.",
  getLatestSelection:
    "Get the most recent selection (persists after focus loss).",
  checkDocumentDirty: "Check whether a file has unsaved changes.",
  saveDocument: "Save a file (or all files) in the editor.",
  openFile: "Open a file in the editor at an optional line and column.",
  closeTab: "Close an editor tab by file path.",
  captureScreenshot: "Take a screenshot of the VS Code window.",
  setEditorDecorations: "Annotate code with inline warning/error decorations.",
  clearEditorDecorations:
    "Remove decorations previously set by setEditorDecorations.",
  openDiff: "Open a side-by-side diff view between two files or content.",
  openInBrowser: "Open a URL or file in the system browser.",
  executeVSCodeCommand: "Run any VS Code command by its command ID.",
  listVSCodeCommands: "List all available VS Code command IDs.",
  listVSCodeTasks: "List configured VS Code tasks from tasks.json.",
  runVSCodeTask: "Run a VS Code task by name.",
  getWorkspaceFolders: "List all workspace folders open in VS Code.",
  setActiveWorkspaceFolder: "Switch the active workspace folder.",
  getWorkspaceSettings: "Read VS Code workspace settings.",
  setWorkspaceSetting: "Write a VS Code workspace setting.",
  formatDocument: "Format a file using the language server formatter.",
  formatRange: "Format a selected range within a file.",
  formatAndSave: "Format then save a file in one step.",
  fixAllLintErrors: "Apply all auto-fixable lint errors in a file.",
  organizeImports: "Sort and remove unused imports in a file.",
  getBufferContent:
    "Read the current content of a file from the VS Code buffer.",
  editText: "Edit a file by replacing a line range.",
  createFile: "Create a new file with optional initial content.",
  deleteFile: "Delete a file from the workspace.",
  renameFile: "Rename or move a file.",
  replaceBlock: "Replace a block of text matching a pattern in a file.",
  searchAndReplace: "Find and replace text across multiple workspace files.",
  findFiles: "Find files matching a glob pattern in the workspace.",
  getFileTree: "List files and directories in the workspace as a tree.",
  readClipboard: "Read the current clipboard content.",
  writeClipboard: "Write text to the clipboard.",
  watchFiles: "Watch a set of files for changes.",
  unwatchFiles: "Stop watching previously watched files.",

  // debug
  getDebugState: "Get the current VS Code debug session state.",
  evaluateInDebugger: "Evaluate an expression inside the active debug session.",
  setDebugBreakpoints: "Set or clear breakpoints in a file.",
  startDebugging: "Start a VS Code debug session.",
  stopDebugging: "Stop the active debug session.",

  // diagnostics / analysis
  runTests: "Run tests using vitest, jest, pytest, cargo test, or go test.",
  getCodeCoverage:
    "Parse lcov/clover coverage and return per-file percentages.",
  detectUnusedCode: "Find unused variables, exports, and dead code.",
  auditDependencies: "Check for outdated npm/cargo/pip packages.",
  getSecurityAdvisories: "Fetch CVE advisories for installed dependencies.",
  generateTests: "Scaffold unit tests for a file or symbol.",
  generateAPIDocumentation: "Generate API documentation for a module.",
  findRelatedTests: "Find test files related to a source file.",
  getDependencyTree: "Show the full npm/cargo dependency tree.",
  screenshotAndAnnotate:
    "Take a screenshot and generate Playwright action steps.",
  searchWorkspace:
    "Full-text search across workspace files (ripgrep or VS Code search).",

  // bridge / orchestration
  getBridgeStatus: "Show bridge and extension connection health.",
  getToolCapabilities:
    "List available tools and whether extension is connected.",
  bridgeDoctor:
    "Run diagnostics to identify common bridge configuration issues.",
  getSessionUsage: "Show tool call counts and error rates for this session.",
  searchTools:
    "Find MCP tools by keyword or category (no bridge connection needed).",
  getProjectInfo: "Get project name, version, and dependency summary.",
  getProjectContext:
    "Get rich project context: git, diagnostics, recent activity.",
  getArchitectureContext:
    "Query codebase memory graph for architectural context.",
  contextBundle:
    "Bundle editor context: open files, selection, git status, diagnostics.",
  watchActivityLog: "Long-poll the activity log for new tool call events.",
  getActivityLog:
    "Retrieve recent tool call activity with optional percentile stats.",
  getAnalyticsReport:
    "Get performance analytics: p50/p95/p99 latency, health score.",
  getHandoffNote:
    "Read the cross-session handoff note for the current workspace.",
  setHandoffNote:
    "Write a cross-session handoff note for the current workspace.",
  getPerformanceReport:
    "Health score 0-100, p50/p95/p99 latency, windowed throughput.",

  // automation / orchestration
  runClaudeTask: "Enqueue a Claude Code subprocess task with a prompt.",
  getClaudeTaskStatus: "Get the status and output of a Claude subprocess task.",
  cancelClaudeTask: "Cancel a running Claude subprocess task.",
  listClaudeTasks: "List all Claude subprocess tasks and their statuses.",
  resumeClaudeTask: "Resume an interrupted Claude subprocess task.",

  // http
  sendHttpRequest: "Send an HTTP request (GET/POST/etc) to an external URL.",
  parseHttpFile: "Parse a .http file and send its requests.",

  // plans
  createPlan: "Create a structured multi-step plan for a task.",
  updatePlan: "Update a step or status in an existing plan.",
  deletePlan: "Delete a plan.",
  getPlan: "Get the details of a plan.",
  listPlans: "List all active plans in the workspace.",
};

// ---------------------------------------------------------------------------
// Core types and helpers
// ---------------------------------------------------------------------------

export interface ToolEntry {
  name: string;
  description: string;
  categories: string[];
}

/** Build the full tool catalog from TOOL_CATEGORIES + TOOL_DESCRIPTIONS. */
export function buildToolCatalog(): ToolEntry[] {
  const seen = new Set<string>();
  const entries: ToolEntry[] = [];

  for (const [name, cats] of Object.entries(TOOL_CATEGORIES)) {
    seen.add(name);
    entries.push({
      name,
      description: TOOL_DESCRIPTIONS[name] ?? "",
      categories: cats,
    });
  }

  // Also include tools in the description map that have no category entry.
  for (const [name, desc] of Object.entries(TOOL_DESCRIPTIONS)) {
    if (!seen.has(name)) {
      entries.push({ name, description: desc, categories: [] });
    }
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Search the tool catalog.
 * @param catalog  Full catalog from buildToolCatalog().
 * @param query    Substring to match against name, description, or categories.
 */
export function searchCatalog(
  catalog: ToolEntry[],
  query: string,
): ToolEntry[] {
  const q = query.toLowerCase().trim();
  if (!q) return catalog;
  return catalog.filter((t) => {
    const haystack = [t.name, t.description, ...t.categories]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
}

/** Group catalog entries by their first category (or "other"). */
export function groupByCategory(
  catalog: ToolEntry[],
): Map<string, ToolEntry[]> {
  const map = new Map<string, ToolEntry[]>();
  for (const entry of catalog) {
    const cat = entry.categories[0] ?? "other";
    const bucket = map.get(cat);
    if (bucket) {
      bucket.push(entry);
    } else {
      map.set(cat, [entry]);
    }
  }
  // Sort keys
  return new Map([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

/** Return the first sentence of a description (up to first "."). */
export function firstSentence(desc: string): string {
  const dot = desc.indexOf(".");
  return dot !== -1 ? desc.slice(0, dot + 1) : desc;
}

// ---------------------------------------------------------------------------
// CLI output helpers
// ---------------------------------------------------------------------------

function printTool(t: ToolEntry, showCategory = true): void {
  const cat =
    showCategory && t.categories.length > 0 ? `  [${t.categories[0]}]` : "";
  const desc = firstSentence(t.description);
  process.stdout.write(`  ${t.name}${cat}\n`);
  if (desc) {
    process.stdout.write(`    ${desc}\n`);
  }
}

function printSearchResults(results: ToolEntry[], query: string): void {
  if (results.length === 0) {
    process.stdout.write(`No tools matched "${query}".\n`);
    return;
  }
  process.stdout.write(
    `${results.length} tool${results.length === 1 ? "" : "s"} matching "${query}":\n\n`,
  );
  for (const t of results) {
    printTool(t);
  }
}

function printGroupedList(grouped: Map<string, ToolEntry[]>): void {
  for (const [cat, entries] of grouped) {
    process.stdout.write(`\n${cat.toUpperCase()} (${entries.length})\n`);
    process.stdout.write(`${"─".repeat(40)}\n`);
    for (const t of entries) {
      printTool(t, false);
    }
  }
}

function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Subcommand entrypoint
// ---------------------------------------------------------------------------

export async function runToolsCommand(argv: string[]): Promise<void> {
  // Strip flag arguments before extracting the subcommand so that
  // `tools --json list` works identically to `tools list --json`.
  const sub = argv.find((a) => !a.startsWith("--"));
  const jsonFlag = argv.includes("--json");

  if (!sub || sub === "--help" || sub === "help") {
    process.stdout.write(`claude-ide-bridge tools — Browse and search tools (no bridge required)

Usage:
  claude-ide-bridge tools search <query> [--json]
  claude-ide-bridge tools list [--json]

Subcommands:
  search <query>  Case-insensitive search on name, description, and category
  list            All tools grouped by category

Options:
  --json          Machine-readable JSON output
`);
    process.exit(0);
  }

  const catalog = buildToolCatalog();

  if (sub === "search") {
    const query = argv
      .filter((a) => !a.startsWith("--") && a !== "search")
      .join(" ")
      .trim();
    if (!query) {
      process.stderr.write("Usage: claude-ide-bridge tools search <query>\n");
      process.exit(1);
    }
    const results = searchCatalog(catalog, query);
    if (jsonFlag) {
      printJson(results);
    } else {
      printSearchResults(results, query);
    }
    return;
  }

  if (sub === "list") {
    const grouped = groupByCategory(catalog);
    if (jsonFlag) {
      const obj: Record<string, ToolEntry[]> = {};
      for (const [cat, entries] of grouped) {
        obj[cat] = entries;
      }
      printJson(obj);
    } else {
      const total = catalog.length;
      process.stdout.write(`claude-ide-bridge — ${total} tools\n`);
      printGroupedList(grouped);
      process.stdout.write("\n");
    }
    return;
  }

  process.stderr.write(`Unknown subcommand: ${sub}\n`);
  process.stderr.write(
    "Usage: claude-ide-bridge tools <search <query> | list>\n",
  );
  process.exit(1);
}
