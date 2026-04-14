// Companion MCP server registry.
// npm package names verified via: npm view <pkg> name
// @modelcontextprotocol/server-memory ✓
// superpowers-mcp ✓
// chrome-devtools-mcp ✓

export interface CompanionEntry {
  description: string;
  npmPackage: string;
  command: string;
  args: string[];
  requiredEnv?: Record<string, string>;
}

export const COMPANIONS: Record<string, CompanionEntry> = {
  memory: {
    description: "Persistent memory across Claude sessions",
    npmPackage: "@modelcontextprotocol/server-memory",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
  },
  superpowers: {
    description: "Structured planning, task decomposition",
    npmPackage: "superpowers-mcp",
    command: "npx",
    args: ["-y", "superpowers-mcp"],
  },
  devtools: {
    description: "Live Chrome DevTools (network, console, DOM)",
    npmPackage: "chrome-devtools-mcp",
    command: "npx",
    args: ["-y", "chrome-devtools-mcp"],
    requiredEnv: { CHROME_DEBUGGING_PORT: "9222" },
  },
};
