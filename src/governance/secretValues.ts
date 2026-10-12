/**
 * Secret-value registry — VALUE-based redaction, composed after key-based.
 *
 * `redactSensitive` in `src/recipes/stepObservation.ts` walks object KEYS:
 * `authorization`, `api_key`, `token` … A secret that has been interpolated
 * into a string — `body: '{"key":"{{env.API_KEY}}"}'`, a URL query, a nested
 * JSON string, a model prompt, an error message quoting the request — has no
 * sensitive key left to match and lands in `runs.jsonl`, the approval
 * payload, the activity log and the orchestrator's task file in clear text.
 *
 * This module holds the VALUES the process has been handed as secrets and
 * substitutes them wherever they reappear, whatever the surrounding key.
 *
 * Constraints, all deliberate:
 *
 *   - The registry is process-local and memory-only. It is never persisted,
 *     never logged, and `JSON.stringify` / `util.inspect` of it reveal
 *     nothing — a registry that leaks is the largest secret index on the box.
 *   - Values shorter than `MIN_SECRET_LENGTH` are ignored. Redacting `abc`
 *     would rewrite ordinary prose, and a 7-character credential is not a
 *     credential this layer can protect without making every log unreadable.
 *   - Longest match first, so a value that is a prefix of another never
 *     leaves the tail of the longer one exposed.
 *   - Common encodings of each value are matched too: URL-encoded, base64,
 *     base64url and JSON-escaped. Cheap to compute once at registration;
 *     impossible to reconstruct at the sink.
 *   - The replacement names the SOURCE (`env`, `connector:gmail`), never the
 *     key and never any part of the value.
 */

import { inspect } from "node:util";

export const MIN_SECRET_LENGTH = 8;
const MAX_SECRET_LENGTH = 16 * 1024;

/**
 * Key-name patterns shared with `redactSensitive`. Normalised: lowercase with
 * `-`, `_`, `.` and whitespace stripped, so `api_key`, `api-key`, `apiKey`
 * and `API_KEY` all reduce to `apikey`.
 */
export const SENSITIVE_KEY_PATTERNS: readonly string[] = [
  "authorization",
  "xapikey",
  "apikey",
  "password",
  "passwd",
  "secret",
  "token",
  "cookie",
  "session",
  "privatekey",
  "clientsecret",
  "refreshtoken",
  "accesstoken",
];

/** Marker for a value removed because its KEY names a secret. */
export const SENSITIVE_KEY_REDACTED = "[REDACTED]";

/**
 * Replace every property whose KEY names a secret (`authorization`, `api_key`,
 * `password`, …) with `[REDACTED]`, recursively. Structural and cheap; it cannot
 * see a secret interpolated into a string — `redactKnownSecretsDeep` covers that.
 * Never feed its output into an identity hash: two different secrets redact to
 * the same text.
 */
export function redactSensitiveKeysDeep(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((v) => redactSensitiveKeysDeep(v, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKeyName(k)
      ? SENSITIVE_KEY_REDACTED
      : redactSensitiveKeysDeep(v, seen);
  }
  return out;
}

export function isSensitiveKeyName(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[-_\s.]/g, "");
  for (const pattern of SENSITIVE_KEY_PATTERNS) {
    if (normalised.includes(pattern)) return true;
  }
  return false;
}

interface Needle {
  /** The literal text to find. */
  text: string;
  /** What replaces it — never the key and never any part of the value. */
  replacement: string;
}

class SecretRegistry {
  /** value → source label. A value registered twice keeps its first label. */
  private readonly values = new Map<string, string>();
  /** Derived needles (raw + encodings), longest first. Rebuilt lazily. */
  private needles: Needle[] | null = null;

  add(value: string, source: string): void {
    if (typeof value !== "string") return;
    if (value.length < MIN_SECRET_LENGTH || value.length > MAX_SECRET_LENGTH)
      return;
    if (value.trim().length < MIN_SECRET_LENGTH) return;
    if (this.values.has(value)) return;
    this.values.set(value, sanitiseSource(source));
    this.needles = null;
  }

  count(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
    this.needles = null;
  }

  getNeedles(): Needle[] {
    if (this.needles) return this.needles;
    const seen = new Map<string, string>();
    for (const [value, source] of this.values) {
      for (const enc of encodings(value)) {
        if (enc.length < MIN_SECRET_LENGTH) continue;
        if (!seen.has(enc)) seen.set(enc, source);
      }
    }
    const out: Needle[] = [];
    for (const [text, source] of seen) {
      out.push({ text, replacement: marker(source) });
    }
    out.sort((a, b) => b.text.length - a.text.length);
    this.needles = out;
    return out;
  }

  // ── Never reveal contents ──────────────────────────────────────────────
  toJSON(): { secretValues: number } {
    return { secretValues: this.values.size };
  }
  toString(): string {
    return `[SecretRegistry ${this.values.size} value(s)]`;
  }
  [inspect.custom](): string {
    return this.toString();
  }
}

function sanitiseSource(source: string): string {
  const s = String(source ?? "").trim();
  if (!s) return "secret";
  // Keep labels short and free of characters that would break the marker.
  return s.replace(/[[\]\r\n]/g, "").slice(0, 48);
}

/** Every cheap encoding under which a value might reappear in text. */
function encodings(value: string): string[] {
  const out = new Set<string>([value]);
  try {
    out.add(encodeURIComponent(value));
  } catch {
    /* lone surrogates — skip */
  }
  const b64 = Buffer.from(value, "utf8").toString("base64");
  out.add(b64);
  out.add(b64.replace(/=+$/, ""));
  out.add(Buffer.from(value, "utf8").toString("base64url"));
  // JSON-escaped form (what `JSON.stringify` embeds inside a string), minus
  // the surrounding quotes. Differs from the raw value only when the value
  // contains characters JSON escapes.
  out.add(JSON.stringify(value).slice(1, -1));
  return [...out];
}

const registry = new SecretRegistry();

/**
 * Run-scoped `type: text` input values (`src/recipes/textInputs.ts`).
 *
 * Not secrets — prose an operator handed one run — but held to the same rule
 * at every sink this module already guards: the ledgers record that a value
 * existed (its length and a hash prefix), never the value. Unlike the secret
 * registry this one is TRANSIENT: a runner registers each value when the run
 * starts and releases it when the run ends (refcounted, so two concurrent runs
 * handed the same text do not release each other's), because prose is large
 * and an ever-growing index of it would be both a memory leak and the largest
 * plaintext copy of exactly what is being kept out of the ledgers.
 *
 * A value shorter than `MIN_SECRET_LENGTH` is replaced only where a whole
 * string IS the value (a field holding exactly it). Substring replacement of a
 * three-character value would rewrite unrelated text in every log line written
 * while the run is live.
 */
class TextValueRegistry {
  private readonly values = new Map<
    string,
    { replacement: string; refs: number }
  >();
  private needles: Needle[] | null = null;

  add(value: string, replacement: string): void {
    const existing = this.values.get(value);
    if (existing) {
      existing.refs++;
      return;
    }
    this.values.set(value, { replacement, refs: 1 });
    this.needles = null;
  }

  release(value: string): void {
    const existing = this.values.get(value);
    if (!existing) return;
    existing.refs--;
    if (existing.refs <= 0) {
      this.values.delete(value);
      this.needles = null;
    }
  }

  count(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
    this.needles = null;
  }

  exact(text: string): string | undefined {
    return this.values.get(text)?.replacement;
  }

  getNeedles(): Needle[] {
    if (this.needles) return this.needles;
    const seen = new Map<string, string>();
    for (const [value, { replacement }] of this.values) {
      if (value.length < MIN_SECRET_LENGTH) continue;
      for (const enc of encodings(value)) {
        if (enc.length < MIN_SECRET_LENGTH) continue;
        if (!seen.has(enc)) seen.set(enc, replacement);
      }
    }
    const out: Needle[] = [];
    for (const [text, replacement] of seen) out.push({ text, replacement });
    this.needles = out;
    return out;
  }

  // ── Never reveal contents ──────────────────────────────────────────────
  toJSON(): { textValues: number } {
    return { textValues: this.values.size };
  }
  toString(): string {
    return `[TextValueRegistry ${this.values.size} value(s)]`;
  }
  [inspect.custom](): string {
    return this.toString();
  }
}

const textValues = new TextValueRegistry();

/**
 * Register one run's text input value for ledger redaction and return the
 * release function the runner calls when the run ends. `replacement` is what
 * every sink records instead (`textInputLedgerMarker`).
 */
export function registerTextInputValue(
  value: string,
  replacement: string,
): () => void {
  if (typeof value !== "string" || value.length === 0) return () => {};
  textValues.add(value, replacement);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    textValues.release(value);
  };
}

export function textInputValueCount(): number {
  return textValues.count();
}

/** Secret needles and text needles as one list, longest first. */
function allNeedles(): Needle[] {
  const secretNeedles = registry.getNeedles();
  if (textValues.count() === 0) return secretNeedles;
  // Longest first ACROSS both lists: a secret inside a text value must not be
  // replaced first, or the text needle stops matching and the rest of the
  // prose is written out around the secret's marker.
  return [...textValues.getNeedles(), ...secretNeedles].sort(
    (a, b) => b.text.length - a.text.length,
  );
}

/**
 * Register one secret value. `source` is a short label — `env`,
 * `connector:gmail`, `config:apiKeys` — used verbatim in the replacement
 * marker, so it must never carry the key name or any part of the value.
 */
export function registerSecretValue(value: string, source: string): void {
  registry.add(value, source);
}

/**
 * Walk an object and register every string value found under a key that
 * matches `SENSITIVE_KEY_PATTERNS`. Nested objects and arrays are walked;
 * cycles are tolerated. The key name itself is NOT recorded anywhere.
 */
export function registerSecretValues(
  obj: unknown,
  source: string,
  opts: { allKeys?: boolean } = {},
): void {
  const seen = new WeakSet<object>();
  const walk = (v: unknown, keyIsSensitive: boolean): void => {
    if (typeof v === "string") {
      if (keyIsSensitive) registry.add(v, source);
      return;
    }
    if (v === null || typeof v !== "object") return;
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const item of v) walk(item, keyIsSensitive);
      return;
    }
    for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
      walk(
        item,
        opts.allKeys === true || keyIsSensitive || isSensitiveKeyName(k),
      );
    }
  };
  walk(obj, opts.allKeys === true);
}

/**
 * Register the values of a recipe's declared `type: env` block. Every value
 * in that block is a secret by declaration — the recipe asked for it from the
 * environment — regardless of its key name.
 *
 * To be called by the runners (`declaredRecipeEnv` callers) — see the report
 * accompanying this module for the exact lines.
 */
export function registerEnvBlock(
  env: Record<string, string | undefined>,
): void {
  for (const v of Object.values(env)) {
    if (typeof v === "string") registry.add(v, "env");
  }
}

/**
 * Register a recipe's `vars:` — only values under sensitive key names, since
 * ordinary vars (`repo`, `channel`) are not secrets and redacting them would
 * hollow out the run log.
 */
export function registerSensitiveVars(vars: Record<string, unknown>): void {
  registerSecretValues(vars, "vars");
}

/** The bridge's own bearer token. `bridge.ts` should call this at startup. */
export function registerBridgeToken(token: string): void {
  registry.add(token, "bridge-token");
}

export function secretValueCount(): number {
  return registry.count();
}

export function _resetSecretValuesForTesting(): void {
  registry.clear();
  textValues.clear();
}

function marker(source: string): string {
  return `[REDACTED:${source}]`;
}

/**
 * Replace every registered secret (and its cheap encodings) in `text`.
 * Returns the input reference unchanged when nothing is registered or
 * nothing matches, so the hot path allocates nothing.
 */
export function redactKnownSecrets(text: string): string {
  if (typeof text !== "string") return text;
  if (textValues.count() > 0) {
    const whole = textValues.exact(text);
    if (whole !== undefined) return whole;
  }
  if (text.length < MIN_SECRET_LENGTH) return text;
  const needles = allNeedles();
  if (needles.length === 0) return text;
  let out = text;
  for (const n of needles) {
    if (out.includes(n.text)) out = out.split(n.text).join(n.replacement);
  }
  return out;
}

/**
 * Walk any value and redact registered secrets inside every string, including
 * object keys and strings that are themselves JSON. Structure is preserved;
 * non-string leaves pass through; cycles become `"[circular]"`.
 *
 * A string that parses as JSON is parsed, redacted structurally and
 * re-stringified — this catches a secret that sits inside a nested JSON
 * document under a JSON-escaped form the flat pass might otherwise handle
 * only partially. Anything that fails to parse falls back to the plain
 * substring pass, which is sufficient on its own; the parse is belt and
 * braces, never a requirement.
 */
export function redactKnownSecretsDeep(value: unknown): unknown {
  if (registry.count() === 0 && textValues.count() === 0) return value;
  return deep(value, new WeakSet<object>());
}

function deep(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => deep(v, seen));
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[redactKnownSecrets(k)] = deep(v, seen);
  }
  return out;
}

function redactString(s: string): string {
  const flat = redactKnownSecrets(s);
  // Only attempt the structural pass on something that looks like JSON and
  // is not already clean — keeps the common case a single `includes` scan.
  if (flat === s) return s;
  const t = s.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return flat;
  try {
    const parsed = JSON.parse(s) as unknown;
    if (parsed === null || typeof parsed !== "object") return flat;
    return JSON.stringify(deep(parsed, new WeakSet<object>()));
  } catch {
    return flat;
  }
}
