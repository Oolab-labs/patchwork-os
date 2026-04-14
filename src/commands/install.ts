import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { COMPANIONS } from "../companions/registry.js";

/** Return platform-specific Claude Desktop config path. */
function getClaudeDesktopConfigPath(): string {
  const platform = os.platform();
  if (platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
  }
  if (platform === "win32") {
    const appData =
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  // Linux
  return path.join(
    os.homedir(),
    ".config",
    "Claude",
    "claude_desktop_config.json",
  );
}

interface DesktopConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

function readConfig(configPath: string): DesktopConfig {
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as DesktopConfig;
  } catch {
    return {};
  }
}

function writeConfigAtomic(configPath: string, config: DesktopConfig): void {
  const dir = path.dirname(configPath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${configPath}.tmp`;
  try {
    unlinkSync(tmpPath);
  } catch {
    /* not present */
  }
  writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf-8",
  });
  renameSync(tmpPath, configPath);
}

export async function runInstall(argv: string[]): Promise<void> {
  const showList = argv.includes("--list") || argv.includes("-l");

  if (showList || argv.length === 0) {
    console.log("Available companions:\n");
    const maxLen = Math.max(...Object.keys(COMPANIONS).map((k) => k.length));
    for (const [name, entry] of Object.entries(COMPANIONS)) {
      const pad = " ".repeat(maxLen - name.length + 2);
      console.log(`  ${name}${pad}${entry.description}`);
      if (entry.requiredEnv) {
        const envStr = Object.entries(entry.requiredEnv)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");
        console.log(`  ${" ".repeat(maxLen + 2)}Requires env: ${envStr}`);
      }
    }
    console.log(`\nUsage: claude-ide-bridge install <companion>`);
    return;
  }

  const companionName = argv[0];

  if (!companionName || companionName.startsWith("-")) {
    process.stderr.write(
      `Error: No companion specified.\nRun 'claude-ide-bridge install --list' to see available companions.\n`,
    );
    process.exit(1);
  }

  const entry = COMPANIONS[companionName];
  if (!entry) {
    const names = Object.keys(COMPANIONS).join(", ");
    process.stderr.write(
      `Error: Unknown companion '${companionName}'.\nAvailable: ${names}\n`,
    );
    process.exit(1);
  }

  // Install npm package globally
  console.log(`Installing ${entry.npmPackage}...`);
  try {
    execFileSync("npm", ["install", "-g", entry.npmPackage], {
      stdio: "inherit",
    });
  } catch {
    process.stderr.write(
      `Error: Failed to install ${entry.npmPackage}. Check npm permissions.\n`,
    );
    process.exit(1);
  }

  // Merge into Claude Desktop config
  const configPath = getClaudeDesktopConfigPath();
  const config = readConfig(configPath);
  if (!config.mcpServers) config.mcpServers = {};

  if (config.mcpServers[companionName] !== undefined) {
    console.log(
      `\n✓ '${companionName}' already configured in Claude Desktop — no changes made.`,
    );
    return;
  }

  const mcpEntry: Record<string, unknown> = {
    command: entry.command,
    args: entry.args,
  };
  if (entry.requiredEnv) {
    mcpEntry.env = entry.requiredEnv;
  }

  config.mcpServers[companionName] = mcpEntry;
  writeConfigAtomic(configPath, config);

  console.log(`\n✓ Added '${companionName}' to ${configPath}`);
  if (entry.requiredEnv) {
    console.log(
      `\nNote: Set the following environment variables before using:`,
    );
    for (const [k, v] of Object.entries(entry.requiredEnv)) {
      console.log(`  export ${k}=${v}`);
    }
  }
  console.log(`\nRestart Claude Desktop to activate.`);
}
