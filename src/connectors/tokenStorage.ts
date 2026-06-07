/**
 * Token Storage — secure credential storage for OAuth tokens.
 *
 * Platform-specific implementations:
 *   - macOS: Keychain (security command)
 *   - Windows: DPAPI (data protection API via PowerShell)
 *   - Linux: Secret Service API (via secret-tool or libsecret)
 *
 * Falls back to file-based encrypted storage if native APIs unavailable.
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";

const SERVICE_NAME = "patchwork-os";

type TokenStorageBackend = "auto" | "native" | "file";

export interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string; // ISO 8601
  scopes?: string[];
}

function storageKey(provider: string): string {
  return `${SERVICE_NAME}.${provider}`;
}

function parseJson<T>(json: string | null): T | null {
  if (json === null) {
    return null;
  }

  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

export function storeSecretJsonSync(provider: string, value: unknown): void {
  const key = storageKey(provider);
  const json = JSON.stringify(value);

  const backend = resolveBackend();

  if (backend === "file") {
    setEncryptedFileSync(key, json);
    // Cross-backend orphan guard: if a prior session wrote to the native
    // keychain (auto-mode default), forcing PATCHWORK_TOKEN_STORAGE_BACKEND=file
    // would leave that stale credential behind. A later session that unsets
    // the env (back to auto) would resolve the stale keychain value first
    // and skip the fresher file. Drop the keychain entry best-effort.
    deleteKeychainItemSync(key);
    return;
  }

  // Audit 2026-06-03 (MEDIUM #21): `native` means keychain-ONLY. Previously it
  // fell through to the same keychain-then-file path as `auto`, so a keychain
  // write failure silently wrote the secret to a file the operator explicitly
  // opted out of. Fail loud instead of downgrading their chosen security level.
  if (backend === "native") {
    if (!setKeychainItemSync(key, json)) {
      throw new Error(
        "PATCHWORK_TOKEN_STORAGE_BACKEND=native but the OS keychain is " +
          "unavailable; refusing to fall back to file storage. Unset the env " +
          "var (or set it to 'auto') to allow encrypted-file fallback.",
      );
    }
    deleteEncryptedFileSync(key); // evict any stale file credential
    return;
  }

  // auto: keychain with encrypted-file fallback.
  if (setKeychainItemSync(key, json)) {
    deleteEncryptedFileSync(key);
    return;
  }

  // Keychain write failed — fall back to the encrypted file. Audit 2026-06-03
  // (HIGH #10): evict any stale keychain entry first. getSecretJsonSync reads
  // the keychain BEFORE the file, so leaving an old entry behind would make it
  // return the stale credential and ignore this fresh write — leaving the
  // connector "connected" with a revoked token until manual cleanup.
  deleteKeychainItemSync(key);
  setEncryptedFileSync(key, json);
}

export function getSecretJsonSync<T>(provider: string): T | null {
  const key = storageKey(provider);
  const backend = resolveBackend();

  if (backend === "file") {
    return parseJson<T>(getEncryptedFileSync(key));
  }

  // Audit 2026-06-03 (MEDIUM #21): `native` reads the keychain ONLY — it must
  // not fall back to the encrypted file (symmetric with the keychain-only
  // write path), so a stale file can never shadow the operator's keychain-only
  // intent.
  if (backend === "native") {
    return parseJson<T>(getKeychainItemSync(key));
  }

  // auto: keychain first, then encrypted-file fallback.
  const fromKeychain = getKeychainItemSync(key);
  if (fromKeychain !== null) {
    return parseJson<T>(fromKeychain);
  }

  return parseJson<T>(getEncryptedFileSync(key));
}

export function deleteSecretJsonSync(provider: string): void {
  const key = storageKey(provider);

  // Always clear both backends. Even when the active backend is "file", a
  // prior session may have stored the credential in the OS keychain; leaving
  // it behind on delete is a credential-lifetime bug (revocation flow leaves
  // a usable token in the keychain that auto-mode would surface later).
  deleteKeychainItemSync(key);
  deleteEncryptedFileSync(key);
}

/**
 * Store tokens securely for a provider.
 */
export async function storeTokens(
  provider: string,
  tokens: StoredToken,
): Promise<void> {
  storeSecretJsonSync(provider, tokens);
}

/**
 * Retrieve stored tokens for a provider.
 */
export async function getTokens(provider: string): Promise<StoredToken | null> {
  return getSecretJsonSync<StoredToken>(provider);
}

/**
 * Delete stored tokens for a provider.
 */
export async function deleteTokens(provider: string): Promise<void> {
  deleteSecretJsonSync(provider);
}

/**
 * List all providers with stored tokens.
 */
export async function listStoredProviders(): Promise<string[]> {
  if (resolveBackend() === "file") {
    return (await listEncryptedFiles()).sort();
  }

  const providers: string[] = [];

  // Check keychain
  const keychainProviders = await listKeychainItems();
  providers.push(...keychainProviders);

  // Check file storage
  const fileProviders = await listEncryptedFiles();
  for (const p of fileProviders) {
    if (!providers.includes(p)) {
      providers.push(p);
    }
  }

  return providers.sort();
}

// Platform implementations are defined at the end of this file

// ============================================================================
// Windows DPAPI (via PowerShell)
// ============================================================================

// Prefer pwsh (PowerShell 7+) over powershell (Windows PowerShell 5.x) when
// both are installed. pwsh is increasingly the default on modern Windows.
// Resolved once per process; falls back to "powershell" if pwsh is absent.
function resolvePs(): string {
  if (process.platform !== "win32") return "powershell";
  try {
    const r = spawnSync("where", ["pwsh"], {
      encoding: "utf-8",
      timeout: 3_000,
    });
    return r.status === 0 ? "pwsh" : "powershell";
  } catch {
    return "powershell";
  }
}
const PS_BIN = resolvePs();

// Process-scoped read cache for DPAPI credentials. PowerShell cold-start is
// 500–1500 ms per call; `getSecretJsonSync` is called per API-key provider at
// every loadConfig hit (up to 4 providers × every webhook). 60 s TTL keeps
// the cache warm across a busy burst while still picking up key rotations.
// Invalidated by setWindowsCredentialSync + deleteWindowsCredentialSync.
const _dpCache = new Map<string, { value: string | null; expires: number }>();
const _DP_CACHE_TTL_MS = 60_000;

function setWindowsCredentialSync(key: string, value: string): boolean {
  if (process.platform !== "win32") return false;

  try {
    // Base64-encode both key and value before embedding in PowerShell to
    // eliminate all quoting and injection hazards. The key is decoded inside
    // PowerShell so it can be used as a filename safely.
    const keyB64 = Buffer.from(key, "utf-8").toString("base64");
    const valueB64 = Buffer.from(value, "utf-8").toString("base64");
    // -AsByteStream replaces -Encoding Byte (removed in PowerShell 7).
    // Fall back to -Encoding Byte for Windows PowerShell 5.x.
    const script = `
      $keyBytes = [System.Convert]::FromBase64String('${keyB64}')
      $safeKey = [System.Text.Encoding]::UTF8.GetString($keyBytes)
      $valueBytes = [System.Convert]::FromBase64String('${valueB64}')
      $protected = [System.Security.Cryptography.ProtectedData]::Protect($valueBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
      $dir = Join-Path $env:LOCALAPPDATA "PatchworkOS" "tokens"
      if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
      $filePath = Join-Path $dir ($safeKey + ".bin")
      try { [System.IO.File]::WriteAllBytes($filePath, $protected) } catch { $protected | Set-Content -Path $filePath -Encoding Byte }
    `;
    const result = spawnSync(PS_BIN, ["-NoProfile", "-Command", script], {
      encoding: "utf-8",
      timeout: 10000,
    });
    if (result.status === 0) _dpCache.delete(key);
    return result.status === 0;
  } catch {
    return false;
  }
}

function getWindowsCredentialSync(key: string): string | null {
  if (process.platform !== "win32") return null;

  const now = Date.now();
  const cached = _dpCache.get(key);
  if (cached && now < cached.expires) return cached.value;

  try {
    // Base64-encode the key so it is never interpolated as PS code — a key
    // containing $, backtick, or $() in a double-quoted PS string would
    // execute arbitrary code.
    // [System.IO.File]::ReadAllBytes works on both PS5 and PS7, replacing
    // Get-Content -Encoding Byte which was removed in PowerShell 7.
    const keyB64 = Buffer.from(key, "utf-8").toString("base64");
    const script = `
      $keyBytes = [System.Convert]::FromBase64String('${keyB64}')
      $safeKey = [System.Text.Encoding]::UTF8.GetString($keyBytes)
      $filePath = Join-Path $env:LOCALAPPDATA "PatchworkOS" "tokens" ($safeKey + ".bin")
      if (Test-Path $filePath) {
        $bytes = [System.IO.File]::ReadAllBytes($filePath)
        $unprotected = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
        [System.Text.Encoding]::UTF8.GetString($unprotected)
      }
    `;
    const result = spawnSync(PS_BIN, ["-NoProfile", "-Command", script], {
      encoding: "utf-8",
      timeout: 10000,
    });
    if (result.status !== 0) {
      _dpCache.set(key, { value: null, expires: now + _DP_CACHE_TTL_MS });
      return null;
    }
    const value = result.stdout.trim() || null;
    _dpCache.set(key, { value, expires: now + _DP_CACHE_TTL_MS });
    return value;
  } catch {
    return null;
  }
}

// ============================================================================
// Encrypted File Storage (Fallback)
// ============================================================================

function getStorageDir(): string {
  const base = process.env.PATCHWORK_HOME ?? join(os.homedir(), ".patchwork");
  return join(base, "tokens");
}

const MASTER_KEY_FILE = ".master.key";

let cachedKey: Buffer | null = null;
let cachedKeyDir: string | null = null;

function legacyDerivedKey(): Buffer {
  // Legacy key: sha256(hostname + username). Kept only for one-time migration
  // of existing encrypted files. New data is encrypted with the random master key.
  const machineId = `${os.hostname()}-${os.userInfo().username}`;
  return crypto.createHash("sha256").update(machineId).digest().slice(0, 32);
}

function getEncryptionKey(): Buffer {
  const dir = getStorageDir();
  const keyPath = join(dir, MASTER_KEY_FILE);

  // Cache is valid only while the key file still exists on disk.
  // Without the existsSync guard, a deleted storage dir (e.g. in tests) would
  // return a stale in-memory key and never write .master.key back to disk.
  if (cachedKey && cachedKeyDir === dir && existsSync(keyPath)) {
    return cachedKey;
  }

  try {
    const key = readFileSync(keyPath);
    if (key.length === 32) {
      cachedKey = key;
      cachedKeyDir = dir;
      return key;
    }
    // Corrupt — replace.
    try {
      unlinkSync(keyPath);
    } catch {}
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Unreadable — best-effort replace.
      try {
        unlinkSync(keyPath);
      } catch {}
    }
    // ENOENT: fall through to generate new key.
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const key = crypto.randomBytes(32);
  try {
    // flag "wx" = O_EXCL: fail if another process created the file in between.
    writeFileSync(keyPath, key, { flag: "wx", mode: 0o600 });
  } catch {
    // Another process may have written it first; prefer that one for consistency.
    try {
      const existing = readFileSync(keyPath);
      if (existing.length === 32) {
        cachedKey = existing;
        cachedKeyDir = dir;
        return existing;
      }
    } catch {}
    // Best effort: fall through with the in-memory key.
  }
  cachedKey = key;
  cachedKeyDir = dir;
  return key;
}

function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

function decryptWith(key: Buffer, encryptedData: string): string | null {
  try {
    const [ivHex, authTagHex, encrypted] = encryptedData.split(":");
    if (!ivHex || !authTagHex || !encrypted) return null;

    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivHex, "hex"),
    );
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch {
    return null;
  }
}

function decrypt(encryptedData: string): string | null {
  return decryptWith(getEncryptionKey(), encryptedData);
}

function setEncryptedFileSync(key: string, value: string): void {
  const dir = getStorageDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const encrypted = encrypt(value);
  const finalPath = join(dir, `${key}.enc`);

  // Atomic write: tmp file + rename. Without this a concurrent reader can
  // observe torn ciphertext mid-write → decrypt() returns null → caller
  // treats the connector as disconnected and triggers a full re-auth.
  // The macOS keychain backend is already atomic at OS level; this guard
  // is for the file backend.
  const tmpPath = `${finalPath}.tmp.${process.pid}.${crypto
    .randomBytes(8)
    .toString("hex")}`;
  try {
    writeFileSync(tmpPath, encrypted, { mode: 0o600 });
    // Belt-and-braces: writeFileSync honours mode on file create, but if
    // the file pre-existed with a permissive mode we'd inherit it. Force
    // 0o600 before rename takes the inode.
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // tmp may not exist — best-effort cleanup
    }
    throw err;
  }
}

function getEncryptedFileSync(key: string): string | null {
  const filePath = join(getStorageDir(), `${key}.enc`);
  try {
    const encrypted = readFileSync(filePath, "utf-8");
    const plain = decrypt(encrypted);
    if (plain !== null) return plain;

    // One-time migration: files encrypted with the old hostname-derived key
    // are re-encrypted under the random master key.
    const legacyPlain = decryptWith(legacyDerivedKey(), encrypted);
    if (legacyPlain !== null) {
      setEncryptedFileSync(key, legacyPlain);
      return legacyPlain;
    }

    return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

function deleteEncryptedFileSync(key: string): void {
  const filePath = join(getStorageDir(), `${key}.enc`);
  try {
    unlinkSync(filePath);
  } catch {
    /* ENOENT is expected; other errors are best-effort */
  }
}

function listEncryptedFiles(): string[] {
  const dir = getStorageDir();
  try {
    const files = readdirSync(dir);
    return files
      .filter((f: string) => f.endsWith(".enc"))
      .map((f: string) =>
        f.replace(`${SERVICE_NAME}.`, "").replace(".enc", ""),
      );
  } catch {
    return [];
  }
}

function deleteWindowsCredentialSync(key: string): boolean {
  if (process.platform !== "win32") return false;

  try {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) return false;
    const filePath = join(localAppData, "PatchworkOS", "tokens", `${key}.bin`);
    if (!existsSync(filePath)) {
      _dpCache.delete(key);
      return true;
    }
    unlinkSync(filePath);
    _dpCache.delete(key);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function resolveBackend(): TokenStorageBackend {
  const backend = process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  if (backend === "file" || backend === "native" || backend === "auto") {
    return backend;
  }
  return "auto";
}

// Platform abstraction

/** Injectable keychain ops — lets tests exercise the native backend + its
 *  fallback paths without touching the real OS credential store. */
export interface KeychainOpsForTest {
  set: (key: string, value: string) => boolean;
  get: (key: string) => string | null;
  delete: (key: string) => boolean;
  /**
   * Optional: returns all provider keys currently stored in the (fake)
   * keychain. When present, `listKeychainItems()` delegates here instead of
   * calling the platform-specific implementation — avoids running the real
   * `security` CLI in tests and lets the test assert which list strategy is
   * used (LOW #10: `find-generic-password` per-key, not `dump-keychain`).
   */
  list?: () => string[];
}
let _keychainOverride: KeychainOpsForTest | null = null;
export function __setKeychainOpsForTest(ops: KeychainOpsForTest | null): void {
  _keychainOverride = ops;
}

function setKeychainItemSync(key: string, value: string): boolean {
  if (_keychainOverride) return _keychainOverride.set(key, value);
  if (process.platform === "darwin") {
    return setMacOSKeychainItemSync(key, value);
  }
  if (process.platform === "win32") {
    return setWindowsCredentialSync(key, value);
  }
  return setLinuxSecretSync(key, value);
}

function getKeychainItemSync(key: string): string | null {
  if (_keychainOverride) return _keychainOverride.get(key);
  if (process.platform === "darwin") {
    return getMacOSKeychainItemSync(key);
  }
  if (process.platform === "win32") {
    return getWindowsCredentialSync(key);
  }
  return getLinuxSecretSync(key);
}

function deleteKeychainItemSync(key: string): boolean {
  if (_keychainOverride) return _keychainOverride.delete(key);
  if (process.platform === "darwin") {
    return deleteMacOSKeychainItemSync(key);
  }
  if (process.platform === "win32") {
    return deleteWindowsCredentialSync(key);
  }
  return deleteLinuxSecretSync(key);
}

function listKeychainItems(): string[] {
  // Honour the test override first — lets tests verify the list path without
  // invoking the real `security` CLI (LOW #10 fix: dump-keychain removed).
  if (_keychainOverride?.list) return _keychainOverride.list();
  // Use the file-based index as the candidate set, then probe each key with
  // find-generic-password. This is O(n_providers) in targeted `security`
  // calls instead of O(keychain_size) for a full dump, and avoids reading
  // unrelated credentials from the user's keychain.
  const candidates = listEncryptedFiles();
  if (process.platform === "darwin") {
    return listMacOSKeychainItems(candidates);
  }
  if (process.platform === "win32") {
    // Handled by file listing
    return [];
  }
  return listLinuxSecrets();
}

// Linux Secret Service
function setLinuxSecretSync(key: string, value: string): boolean {
  try {
    const result = spawnSync(
      "secret-tool",
      ["store", "--label", key, "service", SERVICE_NAME, "account", key],
      { input: value, encoding: "utf-8", timeout: 5000 },
    );
    return result.status === 0;
  } catch {
    return false;
  }
}

function getLinuxSecretSync(key: string): string | null {
  try {
    const result = spawnSync(
      "secret-tool",
      ["lookup", "service", SERVICE_NAME, "account", key],
      { encoding: "utf-8", timeout: 5000 },
    );
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim();
    }
    return null;
  } catch {
    return null;
  }
}

function deleteLinuxSecretSync(key: string): boolean {
  try {
    const result = spawnSync(
      "secret-tool",
      ["clear", "service", SERVICE_NAME, "account", key],
      { encoding: "utf-8", timeout: 5000 },
    );
    return result.status === 0;
  } catch {
    return false;
  }
}

function listLinuxSecrets(): string[] {
  // secret-tool doesn't have a list command; we'd need libsecret bindings
  return [];
}

// Rename the platform-specific functions to avoid conflicts
function setMacOSKeychainItemSync(key: string, value: string): boolean {
  // Audit 2026-06-03 (HIGH #3): pass credential via env var, not as a -w
  // argument. Process args appear in `ps aux` output and are readable by any
  // local process for the duration of the spawnSync call. Environment variables
  // require elevated access to inspect on macOS. The shell reads $PATCHWORK_KCV
  // and expands it into security's -w argument; the bridge process itself never
  // carries the credential in its own arg list.
  try {
    const result = spawnSync(
      "/bin/sh",
      [
        "-c",
        'security add-generic-password -s "$1" -a "$2" -U -w "$PATCHWORK_KCV"',
        "--",
        key,
        SERVICE_NAME,
      ],
      {
        encoding: "utf-8",
        timeout: 5000,
        env: { ...process.env, PATCHWORK_KCV: value },
      },
    );
    return result.status === 0;
  } catch {
    return false;
  }
}

function getMacOSKeychainItemSync(key: string): string | null {
  try {
    const result = spawnSync(
      "security",
      ["find-generic-password", "-s", key, "-a", SERVICE_NAME, "-w"],
      { encoding: "utf-8", timeout: 5000 },
    );
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim();
    }
    return null;
  } catch {
    return null;
  }
}

function deleteMacOSKeychainItemSync(key: string): boolean {
  try {
    const result = spawnSync(
      "security",
      ["delete-generic-password", "-s", key, "-a", SERVICE_NAME],
      { encoding: "utf-8", timeout: 5000 },
    );
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * List providers whose tokens exist in the macOS Keychain, probing only the
 * candidate set. Uses `find-generic-password -s <key> -a <account>` per
 * candidate — O(n_providers) targeted queries that never read unrelated
 * keychain entries (replaces the old `dump-keychain` O(keychain_size) approach,
 * audit 2026-06-03 LOW #10).
 */
function listMacOSKeychainItems(candidates: string[]): string[] {
  const providers: string[] = [];
  for (const provider of candidates) {
    try {
      const key = `${SERVICE_NAME}.${provider}`;
      const result = spawnSync(
        "security",
        ["find-generic-password", "-s", key, "-a", SERVICE_NAME],
        { encoding: "utf-8", timeout: 5000 },
      );
      if (result.status === 0) {
        providers.push(provider);
      }
    } catch {
      // Probe failed — treat as not present, continue.
    }
  }
  return providers;
}
