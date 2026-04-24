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
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
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

  if (resolveBackend() === "file") {
    setEncryptedFileSync(key, json);
    return;
  }

  if (setKeychainItemSync(key, json)) {
    deleteEncryptedFileSync(key);
    return;
  }

  setEncryptedFileSync(key, json);
}

export function getSecretJsonSync<T>(provider: string): T | null {
  const key = storageKey(provider);

  if (resolveBackend() === "file") {
    return parseJson<T>(getEncryptedFileSync(key));
  }

  const fromKeychain = getKeychainItemSync(key);
  if (fromKeychain !== null) {
    return parseJson<T>(fromKeychain);
  }

  return parseJson<T>(getEncryptedFileSync(key));
}

export function deleteSecretJsonSync(provider: string): void {
  const key = storageKey(provider);

  if (resolveBackend() === "file") {
    deleteEncryptedFileSync(key);
    return;
  }

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

function setWindowsCredentialSync(key: string, value: string): boolean {
  if (process.platform !== "win32") return false;

  try {
    const script = `
      $bytes = [System.Text.Encoding]::UTF8.GetBytes('${value.replace(/'/g, "''")}')
      $protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
      $path = Join-Path $env:LOCALAPPDATA "PatchworkOS" "tokens"
      if (-not (Test-Path $path)) { New-Item -ItemType Directory -Path $path -Force | Out-Null }
      $protected | Set-Content -Path (Join-Path $path "${key}.bin") -Encoding Byte
    `;
    const result = spawnSync("powershell", ["-Command", script], {
      encoding: "utf-8",
      timeout: 10000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function getWindowsCredentialSync(key: string): string | null {
  if (process.platform !== "win32") return null;

  try {
    const script = `
      $path = Join-Path $env:LOCALAPPDATA "PatchworkOS" "tokens" "${key}.bin"
      if (Test-Path $path) {
        $bytes = Get-Content -Path $path -Encoding Byte -Raw
        $unprotected = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
        [System.Text.Encoding]::UTF8.GetString($unprotected)
      }
    `;
    const result = spawnSync("powershell", ["-Command", script], {
      encoding: "utf-8",
      timeout: 10000,
    });
    if (result.status !== 0) {
      return null;
    }
    return result.stdout.trim() || null;
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

  if (cachedKey && cachedKeyDir === dir && existsSync(keyPath)) {
    return cachedKey;
  }

  if (existsSync(keyPath)) {
    try {
      const key = readFileSync(keyPath);
      if (key.length === 32) {
        cachedKey = key;
        cachedKeyDir = dir;
        return key;
      }
    } catch {
      // fall through to regenerate
    }
    // Corrupt or unreadable — replace.
    try {
      unlinkSync(keyPath);
    } catch {}
  }

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

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
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const encrypted = encrypt(value);
  writeFileSync(join(dir, `${key}.enc`), encrypted, { mode: 0o600 });
}

function getEncryptedFileSync(key: string): string | null {
  const filePath = join(getStorageDir(), `${key}.enc`);
  if (!existsSync(filePath)) return null;

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
  } catch {
    return null;
  }
}

function deleteEncryptedFileSync(key: string): void {
  const filePath = join(getStorageDir(), `${key}.enc`);
  if (existsSync(filePath)) {
    try {
      unlinkSync(filePath);
    } catch {}
  }
}

function listEncryptedFiles(): string[] {
  const dir = getStorageDir();
  if (!existsSync(dir)) return [];

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
    if (!existsSync(filePath)) return true;
    unlinkSync(filePath);
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
function setKeychainItemSync(key: string, value: string): boolean {
  if (process.platform === "darwin") {
    return setMacOSKeychainItemSync(key, value);
  }
  if (process.platform === "win32") {
    return setWindowsCredentialSync(key, value);
  }
  return setLinuxSecretSync(key, value);
}

function getKeychainItemSync(key: string): string | null {
  if (process.platform === "darwin") {
    return getMacOSKeychainItemSync(key);
  }
  if (process.platform === "win32") {
    return getWindowsCredentialSync(key);
  }
  return getLinuxSecretSync(key);
}

function deleteKeychainItemSync(key: string): boolean {
  if (process.platform === "darwin") {
    return deleteMacOSKeychainItemSync(key);
  }
  if (process.platform === "win32") {
    return deleteWindowsCredentialSync(key);
  }
  return deleteLinuxSecretSync(key);
}

function listKeychainItems(): string[] {
  if (process.platform === "darwin") {
    return listMacOSKeychainItems();
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
  try {
    const result = spawnSync(
      "security",
      [
        "add-generic-password",
        "-s",
        key,
        "-a",
        SERVICE_NAME,
        "-w",
        value,
        "-U",
      ],
      { encoding: "utf-8", timeout: 5000 },
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

function listMacOSKeychainItems(): string[] {
  try {
    const result = spawnSync("security", ["dump-keychain"], {
      encoding: "utf-8",
      timeout: 10000,
    });
    if (result.status !== 0) return [];

    const providers: string[] = [];
    const regex = new RegExp(`svce<blob>=${SERVICE_NAME}\\.([^\\s]+)`, "g");
    let match: RegExpExecArray | null;
    while ((match = regex.exec(result.stdout)) !== null) {
      const provider = match[1];
      if (provider) {
        providers.push(provider);
      }
    }
    return providers;
  } catch {
    return [];
  }
}
