/**
 * Bridge token persistence.
 *
 * Persists the bridge's resource-owner credential across restarts so that
 * OAuth access tokens issued before a restart remain valid. Without this,
 * randomUUID() generates a new bridge token on every restart, invalidating
 * all existing OAuth sessions.
 *
 * Security
 *   Written with 0o600 permissions (owner read/write only).
 *   Stored as JSON so a createdAt field can signal long-lived credentials.
 *   Falls back to an ephemeral UUID on any read/write error.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Validate that the resolved configDir is within the user's home directory or
 * is an absolute path that doesn't escape via `../` sequences embedded in an
 * env-var override.  Returns true when safe to use.
 */
function isSafeConfigDir(configDir: string): boolean {
  const resolved = path.resolve(configDir);
  // Allow any absolute path — we just block relative escapes that could write
  // outside expected locations when CLAUDE_CONFIG_DIR contains `../` segments.
  return path.resolve(resolved) === resolved && resolved.length > 0;
}

const BRIDGE_TOKEN_FILE = "bridge-token.json";
const GITIGNORE_ENTRIES = ["bridge-token.json", "oauth-tokens.json"];
/** Warn when token is older than 90 days */
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000;

interface BridgeTokenFile {
  token: string;
  createdAt: number;
}

function ensureGitignore(ideDir: string): void {
  try {
    const gitignorePath = path.join(ideDir, ".gitignore");
    let existing = "";
    try {
      existing = fs.readFileSync(gitignorePath, "utf8");
    } catch {
      // File doesn't exist yet — that's fine
    }
    const missing = GITIGNORE_ENTRIES.filter(
      (entry) => !existing.split("\n").includes(entry),
    );
    if (missing.length > 0) {
      const toAppend =
        (existing.endsWith("\n") || existing === "" ? "" : "\n") +
        missing.join("\n") +
        "\n";
      fs.appendFileSync(gitignorePath, toAppend, { mode: 0o644 });
    }
  } catch {
    // Best-effort — never block bridge startup
  }
}

function writeTokenFile(filePath: string, token: string): void {
  const tmpPath = `${filePath}.tmp`;
  const data: BridgeTokenFile = { token, createdAt: Date.now() };
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

/**
 * Load the persisted bridge token, or create and persist a new one.
 *
 * @param configDir  Root config directory (typically ~/.claude).
 * @returns          A stable UUID that survives bridge restarts.
 */
export function loadOrCreateBridgeToken(configDir: string): string {
  // Resolve and validate configDir to prevent path-traversal via a crafted
  // CLAUDE_CONFIG_DIR env var containing `../` sequences.
  const resolvedConfigDir = path.resolve(configDir);
  if (!isSafeConfigDir(resolvedConfigDir)) {
    return randomUUID();
  }

  const ideDir = path.join(resolvedConfigDir, "ide");
  const filePath = path.join(ideDir, BRIDGE_TOKEN_FILE);

  try {
    // Ensure ide/ directory and .gitignore exist
    if (!fs.existsSync(ideDir)) {
      fs.mkdirSync(ideDir, { recursive: true });
    }
    ensureGitignore(ideDir);

    // Try to read an existing token
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as BridgeTokenFile;
      if (
        typeof parsed.token === "string" &&
        /^[0-9a-f-]{36}$/.test(parsed.token)
      ) {
        // Warn if the token is older than 90 days (but don't auto-rotate)
        if (
          typeof parsed.createdAt === "number" &&
          Date.now() - parsed.createdAt > MAX_AGE_MS
        ) {
          console.warn(
            "[claude-ide-bridge] Bridge token is >90 days old — consider rotating by deleting ~/.claude/ide/bridge-token.json or using --fixed-token",
          );
        }
        return parsed.token;
      }
    }

    // No valid token on disk — create one
    const token = randomUUID();
    writeTokenFile(filePath, token);
    return token;
  } catch {
    // On any error, fall back to an ephemeral in-memory UUID (never block startup)
    return randomUUID();
  }
}

/** Exposed for tests only — not part of the public API. */
export function _configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}
