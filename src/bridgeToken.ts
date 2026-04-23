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

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getSecretJsonSync,
  storeSecretJsonSync,
} from "./connectors/tokenStorage.js";

/**
 * Validate that the resolved configDir is within the user's home directory.
 * Blocks path-traversal via crafted CLAUDE_CONFIG_DIR env-var values that
 * contain `../` sequences pointing outside the home directory.
 */
function isSafeConfigDir(configDir: string): boolean {
  const resolved = path.resolve(configDir);
  const home = path.resolve(os.homedir());
  const tmp = path.resolve(os.tmpdir());
  return (
    resolved === home ||
    resolved.startsWith(home + path.sep) ||
    resolved === tmp ||
    resolved.startsWith(tmp + path.sep)
  );
}

const BRIDGE_TOKEN_FILE = "bridge-token.json";
const GITIGNORE_ENTRIES = ["bridge-token.json", "oauth-tokens.json"];
/** Warn when token is older than 90 days */
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000;

interface BridgeTokenFile {
  token: string;
  createdAt: number;
}

function bridgeTokenProvider(configDir: string): string {
  const digest = createHash("sha256")
    .update(path.resolve(configDir))
    .digest("hex")
    .slice(0, 24);
  return `bridge-token-${digest}`;
}

function normalizeTokenFile(value: unknown): BridgeTokenFile | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const token = (value as { token?: unknown }).token;
  if (typeof token !== "string" || !/^[0-9a-f-]{36}$/.test(token)) {
    return null;
  }

  const createdAt = (value as { createdAt?: unknown }).createdAt;
  return {
    token,
    createdAt: typeof createdAt === "number" ? createdAt : Date.now(),
  };
}

function readStoredToken(configDir: string): BridgeTokenFile | null {
  return normalizeTokenFile(
    getSecretJsonSync<BridgeTokenFile>(bridgeTokenProvider(configDir)),
  );
}

function readLegacyTokenFile(filePath: string): BridgeTokenFile | null {
  try {
    return normalizeTokenFile(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

function warnIfTokenIsOld(createdAt: number): void {
  if (Date.now() - createdAt > MAX_AGE_MS) {
    console.warn(
      "[claude-ide-bridge] Bridge token is >90 days old — consider rotating by deleting ~/.claude/ide/bridge-token.json or using --fixed-token",
    );
  }
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

function writeTokenFile(
  configDir: string,
  filePath: string,
  token: string,
  createdAt = Date.now(),
): void {
  storeSecretJsonSync(bridgeTokenProvider(configDir), { token, createdAt });

  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch {}
  }
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

    const stored = readStoredToken(resolvedConfigDir);
    if (stored) {
      warnIfTokenIsOld(stored.createdAt);
      return stored.token;
    }

    if (fs.existsSync(filePath)) {
      const parsed = readLegacyTokenFile(filePath);
      if (parsed) {
        writeTokenFile(
          resolvedConfigDir,
          filePath,
          parsed.token,
          parsed.createdAt,
        );
        warnIfTokenIsOld(parsed.createdAt);
        return parsed.token;
      }
    }

    const token = randomUUID();
    writeTokenFile(resolvedConfigDir, filePath, token);
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
