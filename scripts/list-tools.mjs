// Enumerates registered tools vs TOOL_CATEGORIES keys for diff. Run after build.
import { registerAllTools, TOOL_CATEGORIES } from "../dist/tools/index.js";

const tools = [];
const transport = {
  registerTool: (schema) => {
    tools.push(schema.name);
  },
  applyToolCategories: () => {},
};
const probes = {
  gh: true,
  rg: true,
  fd: true,
  eslint: true,
  biome: true,
  tsc: true,
  pytest: true,
  jest: true,
  vitest: true,
  cargo: true,
  go: true,
  pyright: true,
  ruff: true,
  typescriptLanguageServer: true,
  universalCtags: true,
};
const config = {
  workspace: "/tmp",
  workspaceFolders: [],
  commandAllowlist: [],
  allowPrivateHttp: false,
  fullMode: true,
  githubDefaultRepo: undefined,
  port: 0,
  automationPolicyPath: null,
  lspVerbosity: "normal",
  linters: [],
  editorCommand: "code",
};
const extensionClient = {
  isConnected: () => false,
  on: () => {},
  removeListener: () => {},
  request: () => Promise.resolve(null),
  latestAIComments: [],
};
const activityLog = {
  query: () => [],
  queryTimeline: () => [],
  subscribe: () => () => {},
  stats: () => ({}),
  getRateLimitRejections: () => 0,
  recordTool: () => {},
  recordEvent: () => {},
  getStats: () => ({}),
};
const orchestrator = {
  spawn: async () => ({ taskId: "x" }),
  getStatus: async () => ({}),
  cancel: async () => ({}),
  listTasks: async () => [],
};
const automationHooks = {
  handleTestRun: () => {},
  handleGitCommit: () => {},
  handleBranchCheckout: () => {},
  handleGitPull: () => {},
  handleGitPush: () => {},
  handlePullRequest: () => {},
};
const commitIssueLinkLog = { append: () => {}, query: () => [] };
const recipeRunLog = { append: () => {}, query: () => [] };
const decisionTraceLog = { append: () => {}, query: () => [] };
registerAllTools(
  transport,
  config,
  new Set(),
  probes,
  extensionClient,
  activityLog,
  "",
  undefined,
  undefined,
  orchestrator,
  "session1",
  [],
  automationHooks,
  undefined,
  undefined,
  undefined,
  commitIssueLinkLog,
  recipeRunLog,
  decisionTraceLog,
);
const cats = TOOL_CATEGORIES;
const registeredSet = new Set(tools);
const catKeys = new Set(Object.keys(cats));
const missingInCats = tools.filter((t) => !catKeys.has(t));
const orphanInCats = Object.keys(cats).filter((k) => !registeredSet.has(k));
console.log("REGISTERED COUNT:", tools.length);
console.log("CATEGORIES KEYS:", Object.keys(cats).length);
console.log("\nTOOLS WITHOUT CATEGORIES:");
for (const t of missingInCats) console.log("  -", t);
console.log("\nORPHAN CATEGORY KEYS (no tool registered with that name):");
for (const k of orphanInCats) console.log("  -", k);
