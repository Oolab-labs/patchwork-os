import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REGISTRY_URL =
  "https://raw.githubusercontent.com/Oolab-labs/claude-ide-bridge/main/scripts/marketplace/registry.json";

const BUNDLED_REGISTRY_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "scripts",
  "marketplace",
  "registry.json",
);

export interface SkillEntry {
  name: string;
  description: string;
  npmPackage: string;
  type: string;
  version: string;
  author: string;
  builtin?: boolean;
}

async function fetchRegistry(): Promise<SkillEntry[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(REGISTRY_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as SkillEntry[];
  } catch {
    // Fall back to bundled copy
    try {
      return JSON.parse(
        readFileSync(BUNDLED_REGISTRY_PATH, "utf-8"),
      ) as SkillEntry[];
    } catch {
      process.stderr.write(
        `Warning: Could not load remote or bundled registry.\n`,
      );
      return [];
    }
  }
}

function printTable(skills: SkillEntry[]): void {
  if (skills.length === 0) {
    console.log("No skills found.");
    return;
  }
  const maxName = Math.max(...skills.map((s) => s.name.length), 4);
  const maxDesc = Math.max(...skills.map((s) => s.description.length), 11);
  const header = `${"Name".padEnd(maxName)}  ${"Description".padEnd(maxDesc)}  Author`;
  console.log(header);
  console.log("-".repeat(header.length));
  for (const s of skills) {
    const builtin = s.builtin ? " (builtin)" : "";
    console.log(
      `${s.name.padEnd(maxName)}  ${s.description.padEnd(maxDesc)}  ${s.author}${builtin}`,
    );
  }
}

export async function runMarketplace(argv: string[]): Promise<void> {
  const sub = argv[0];

  if (!sub || sub === "--help" || sub === "-h") {
    console.log(`claude-ide-bridge marketplace — Community skill marketplace

Usage: claude-ide-bridge marketplace <command> [options]

Commands:
  list                   List all available skills
  install <skill>        Install a skill
  search <query>         Search skills by name or description

Options:
  --help                 Show this help`);
    return;
  }

  if (sub === "list") {
    const skills = await fetchRegistry();
    printTable(skills);
    return;
  }

  if (sub === "search") {
    const query = argv[1];
    if (!query) {
      process.stderr.write(`Error: search requires a query string.\n`);
      process.exit(1);
    }
    const skills = await fetchRegistry();
    const q = query.toLowerCase();
    const matches = skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q),
    );
    if (matches.length === 0) {
      console.log(`No skills matching '${query}'.`);
    } else {
      printTable(matches);
    }
    return;
  }

  if (sub === "install") {
    const skillName = argv[1];
    if (!skillName) {
      process.stderr.write(
        `Error: install requires a skill name.\nRun 'claude-ide-bridge marketplace list' to see available skills.\n`,
      );
      process.exit(1);
    }
    const skills = await fetchRegistry();
    const entry = skills.find((s) => s.name === skillName);
    if (!entry) {
      process.stderr.write(
        `Error: Unknown skill '${skillName}'.\nRun 'claude-ide-bridge marketplace list' to see available skills.\n`,
      );
      process.exit(1);
    }
    if (entry.builtin) {
      console.log(
        `'${skillName}' is a builtin skill included with claude-ide-bridge.\nNo installation needed — it's already available.`,
      );
      return;
    }
    console.log(`Installing ${entry.npmPackage}...`);
    try {
      execFileSync("npm", ["install", "-g", entry.npmPackage], {
        stdio: "inherit",
      });
    } catch {
      process.stderr.write(`Error: Failed to install ${entry.npmPackage}.\n`);
      process.exit(1);
    }
    console.log(`\n✓ Installed '${skillName}'.`);
    console.log(
      `\nAdd to your bridge start command:\n  --plugin ${entry.npmPackage}`,
    );
    return;
  }

  process.stderr.write(
    `Error: Unknown marketplace command '${sub}'.\nRun 'claude-ide-bridge marketplace --help' for usage.\n`,
  );
  process.exit(1);
}
