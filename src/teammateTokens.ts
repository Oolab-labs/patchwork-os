/**
 * Teammate token management: generation, storage, verification, and hot-reload.
 *
 * Token format: cib_{8-char-identifier}_{32-char-secret}
 * Storage:      ~/.claude/ide/tokens.json with SHA-256 hashes (never raw secrets)
 * Lookup:       O(1) by identifier → timingSafeEqual on hash (no count leakage)
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TOKEN_PREFIX = "cib";
const IDENTIFIER_LENGTH = 8; // hex chars
const SECRET_LENGTH = 32; // hex chars
const TOKEN_REGEX = new RegExp(
  `^${TOKEN_PREFIX}_[0-9a-f]{${IDENTIFIER_LENGTH}}_[0-9a-f]{${SECRET_LENGTH}}$`,
);
const NAME_REGEX = /^[a-zA-Z0-9_-]{1,32}$/;

/** Debounce interval for updating lastUsedAt (avoid disk thrash). */
const LAST_USED_DEBOUNCE_MS = 60_000; // 1 minute

export interface StoredToken {
  identifier: string;
  name: string;
  sha256Hash: string;
  scopes: ("full" | "read-only")[];
  createdAt: string;
  lastUsedAt?: string;
}

export interface TokensFile {
  version: 1;
  tokens: StoredToken[];
}

export interface VerifiedToken {
  name: string;
  scopes: ("full" | "read-only")[];
}

/**
 * Parse a prefixed token string into its components.
 * Returns null if the format is invalid.
 */
export function parseToken(
  raw: string,
): { identifier: string; secret: string } | null {
  if (!TOKEN_REGEX.test(raw)) return null;
  const parts = raw.split("_");
  if (parts.length !== 3 || !parts[1] || !parts[2]) return null;
  return { identifier: parts[1], secret: parts[2] };
}

/** SHA-256 hash of a raw token string, returned as hex. */
function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * Generate a new teammate token.
 * Returns both the raw token (display once, never store) and the storable form.
 */
export function generateToken(
  name: string,
  scopes: ("full" | "read-only")[] = ["full"],
): { token: string; stored: StoredToken } {
  if (!NAME_REGEX.test(name)) {
    throw new Error(
      `Invalid teammate name "${name}": must be 1-32 chars [a-zA-Z0-9_-]`,
    );
  }

  const identifier = crypto.randomBytes(4).toString("hex"); // 8 hex chars
  const secret = crypto.randomBytes(16).toString("hex"); // 32 hex chars
  const token = `${TOKEN_PREFIX}_${identifier}_${secret}`;

  return {
    token,
    stored: {
      identifier,
      name,
      sha256Hash: hashToken(token),
      scopes,
      createdAt: new Date().toISOString(),
    },
  };
}

/** Validate a teammate name. */
export function isValidName(name: string): boolean {
  return NAME_REGEX.test(name);
}

/** Validate a raw token format. */
export function isValidTokenFormat(raw: string): boolean {
  return TOKEN_REGEX.test(raw);
}

/** Load tokens from disk into a Map keyed by identifier for O(1) lookup. */
export function loadTokens(tokensPath: string): Map<string, StoredToken> {
  const map = new Map<string, StoredToken>();
  try {
    const raw = fs.readFileSync(tokensPath, "utf8");
    const data = JSON.parse(raw) as TokensFile;
    if (data.version !== 1 || !Array.isArray(data.tokens)) return map;
    for (const t of data.tokens) {
      if (
        typeof t.identifier === "string" &&
        typeof t.name === "string" &&
        typeof t.sha256Hash === "string" &&
        /^[0-9a-f]{64}$/.test(t.sha256Hash) &&
        Array.isArray(t.scopes)
      ) {
        map.set(t.identifier, t);
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      process.stderr.write(
        `[teammateTokens] Failed to load ${tokensPath}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  return map;
}

/** Save tokens to disk atomically (write tmp + rename). */
export function saveTokens(
  tokensPath: string,
  tokens: Map<string, StoredToken>,
): void {
  const dir = path.dirname(tokensPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const data: TokensFile = {
    version: 1,
    tokens: [...tokens.values()],
  };

  const tmpPath = `${tokensPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), {
    mode: 0o600,
  });
  fs.renameSync(tmpPath, tokensPath);
  fs.chmodSync(tokensPath, 0o600);
}

/**
 * Verify a raw token against the stored tokens map.
 * Returns the verified token info or null if not found / invalid.
 * O(1) lookup by identifier, single timingSafeEqual on hash.
 */
export function verifyToken(
  raw: string,
  tokens: Map<string, StoredToken>,
): VerifiedToken | null {
  const parsed = parseToken(raw);
  if (!parsed) return null;

  const stored = tokens.get(parsed.identifier);
  if (!stored) return null;

  const inputHash = Buffer.from(hashToken(raw), "hex");
  const storedHash = Buffer.from(stored.sha256Hash, "hex");

  if (inputHash.length !== storedHash.length) return null;
  if (!crypto.timingSafeEqual(inputHash, storedHash)) return null;

  return { name: stored.name, scopes: stored.scopes };
}

/**
 * Watch tokens file for changes and reload automatically.
 * Returns an unsubscribe function.
 */
export function watchTokensFile(
  tokensPath: string,
  onReload: (tokens: Map<string, StoredToken>) => void,
): () => void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let watcher: fs.FSWatcher | null = null;

  try {
    // Ensure the file exists before watching (fs.watch requires it on some platforms)
    if (!fs.existsSync(tokensPath)) {
      const dir = path.dirname(tokensPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      saveTokens(tokensPath, new Map());
    }

    watcher = fs.watch(tokensPath, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const reloaded = loadTokens(tokensPath);
        onReload(reloaded);
      }, 200);
    });

    // Also listen for SIGHUP for manual reload
    const sighupHandler = () => {
      const reloaded = loadTokens(tokensPath);
      onReload(reloaded);
    };
    process.on("SIGHUP", sighupHandler);

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (watcher) watcher.close();
      process.off("SIGHUP", sighupHandler);
    };
  } catch {
    // If watching fails (e.g., NFS), return no-op unsubscribe
    return () => {};
  }
}

/**
 * Update lastUsedAt for a token (debounced to avoid disk thrash).
 * Fire-and-forget — never blocks the caller.
 */
const lastUsedTimers = new Map<string, number>();

export function touchLastUsed(tokensPath: string, identifier: string): void {
  const now = Date.now();
  const lastTouch = lastUsedTimers.get(identifier) ?? 0;
  if (now - lastTouch < LAST_USED_DEBOUNCE_MS) return;
  lastUsedTimers.set(identifier, now);

  // Fire-and-forget async disk update
  void (async () => {
    try {
      const tokens = loadTokens(tokensPath);
      const stored = tokens.get(identifier);
      if (stored) {
        stored.lastUsedAt = new Date().toISOString();
        saveTokens(tokensPath, tokens);
      }
    } catch {
      // Best-effort — don't crash on disk errors
    }
  })();
}

/** Get the default tokens file path. */
export function defaultTokensPath(): string {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(configDir, "ide", "tokens.json");
}
