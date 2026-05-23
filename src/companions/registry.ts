// Companion MCP server registry.
// npm package names verified via: npm view <pkg> name
// @modelcontextprotocol/server-memory ✓
// superpowers-mcp ✓
// chrome-devtools-mcp ✓
// @bytebase/dbhub ✓
// slack-mcp-server ✓
// @playwright/mcp ✓
// codebase-memory-mcp — binary only, not on npm (skipNpmInstall: true)

export interface CompanionEntry {
  description: string;
  npmPackage: string;
  command: string;
  args: string[];
  requiredEnv?: Record<string, string>;
  /** Printed after install completes — use for post-install manual steps. */
  postInstallMessage?: string;
  /** Skip `npm install -g` step — for binary-only companions installed via other means. */
  skipNpmInstall?: boolean;
}

export const COMPANIONS: Record<string, CompanionEntry> = {
  memory: {
    description: "Persistent memory across Claude sessions",
    npmPackage: "@modelcontextprotocol/server-memory",
    command: "npx",
    // Pinned: npm view @modelcontextprotocol/server-memory version → 2026.1.26 (2026-05-23)
    args: ["-y", "@modelcontextprotocol/server-memory@2026.1.26"],
  },
  superpowers: {
    description: "Structured planning, task decomposition",
    npmPackage: "superpowers-mcp",
    command: "npx",
    // Pinned: npm view superpowers-mcp version → 4.3.2 (2026-05-23)
    args: ["-y", "superpowers-mcp@4.3.2"],
  },
  // To connect to an existing Chrome instead of auto-launching:
  // add --browser-url http://127.0.0.1:9222 to args.
  devtools: {
    description:
      "Full Chrome browser control — automate, debug, inspect network/console/performance",
    npmPackage: "chrome-devtools-mcp",
    command: "npx",
    // Pinned: npm view chrome-devtools-mcp version → 1.0.1 (2026-05-23)
    args: ["-y", "chrome-devtools-mcp@1.0.1"],
  },
  database: {
    description:
      "Multi-database query tools (Postgres, MySQL, SQLite, SQL Server, MariaDB)",
    npmPackage: "@bytebase/dbhub",
    command: "npx",
    // Pinned: npm view @bytebase/dbhub version → 0.21.2 (2026-05-23)
    args: ["-y", "@bytebase/dbhub@0.21.2", "--transport", "stdio"],
    requiredEnv: { DSN: "<postgresql://user:pass@localhost/mydb>" },
    postInstallMessage:
      "Replace the DSN placeholder in claude_desktop_config.json with your real connection string,\n" +
      "or use: claude-ide-bridge install database --env DSN=postgresql://user:pass@localhost/mydb\n" +
      "Multiple databases: add a second entry manually with key 'database-mysql' etc.",
  },
  slack: {
    description:
      "Post Slack messages from automation hooks (onPullRequest, onGitPush, etc.)",
    npmPackage: "slack-mcp-server",
    command: "npx",
    // Pinned: npm view slack-mcp-server version → 1.3.0 (2026-05-23)
    args: ["-y", "slack-mcp-server@1.3.0"],
    requiredEnv: {
      SLACK_BOT_TOKEN: "<xoxb-your-token>",
      SLACK_TEAM_ID: "<T00000000>",
    },
    postInstallMessage:
      "Replace SLACK_BOT_TOKEN and SLACK_TEAM_ID in claude_desktop_config.json,\n" +
      "or use: claude-ide-bridge install slack --env SLACK_BOT_TOKEN=xoxb-... --env SLACK_TEAM_ID=T...",
  },
  playwright: {
    description:
      "AI-driven browser automation — navigate, click, fill forms, screenshot (e2e testing)",
    npmPackage: "@playwright/mcp",
    command: "npx",
    // Pinned: npm view @playwright/mcp version → 0.0.75 (2026-05-23)
    args: ["-y", "@playwright/mcp@0.0.75"],
    postInstallMessage:
      "Browsers must be installed separately:\n  npx playwright install chromium",
  },
  "codebase-memory": {
    description:
      "Codebase knowledge graph — call chains, architecture overview, blast-radius analysis (66 languages)",
    npmPackage: "codebase-memory-mcp",
    command: "codebase-memory-mcp",
    args: [],
    skipNpmInstall: true,
    postInstallMessage:
      // WARNING: curl|bash install has no integrity check — replace with versioned npm package when available on npm
      "Install the binary first (not on npm):\n" +
      "  curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash\n" +
      "Then restart Claude Desktop.",
  },
};
