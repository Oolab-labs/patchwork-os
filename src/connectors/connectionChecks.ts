/**
 * What `GET /connections` may say about a connection beyond "connected",
 * and the one place each of those facts is recorded.
 *
 * Every field here is either a value something actually recorded or it is
 * absent. Absent means "not recorded", never "now" and never a default: a
 * timestamp made up at read time looks exactly like a real one, which is how
 * the list came to report every connection as synced the moment it was asked.
 *
 * Three facts live here:
 *
 *   - **Connection checks** (`verifiedAt`, `lastCheck`) — written when an
 *     operator runs a connection Test (`POST /connections/<id>/test`), for
 *     every connector, from the Test's own result. Kept per connector in one
 *     small file in the token directory, next to the stored credentials. It
 *     holds no secret material: times, a pass/fail flag and a short reason
 *     code — never a response body, never a message from the provider.
 *     The entry is dropped whenever the credential is replaced or removed
 *     (connect, OAuth callback, disconnect), so a check never outlives the
 *     credential it was about.
 *   - **Stored connection metadata** (`connectedAt`, `account`) — read from
 *     what the connector already stored when it connected.
 *   - **Revoke outcome** — what a disconnect could say about the credential
 *     at the provider.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { patchworkPath } from "../patchworkHome.js";

// ── Connection checks ────────────────────────────────────────────────────────

/**
 * Why a Test did not pass, as a short code. Deliberately a closed set: the
 * provider's own words can carry a response body, an account detail or a
 * token fragment, and none of that belongs in a status file.
 *
 *   - `failed` — the Test ran and the provider call did not succeed.
 *   - `error`  — the Test itself errored (HTTP 5xx from the Test handler).
 *
 * There is deliberately no "unauthorized": most Test handlers answer 401 for
 * ANY failed health check, so the status cannot tell a rejected credential
 * from an outage, and a reason that guessed would send the operator to
 * re-enter a credential that is fine.
 */
export type CheckFailureReason = "failed" | "error";

const REASONS: ReadonlySet<string> = new Set<CheckFailureReason>([
  "failed",
  "error",
]);

export interface LastCheck {
  /** ISO time the Test finished. */
  at: string;
  ok: boolean;
  /** Present only when `ok` is false. */
  reason?: CheckFailureReason;
}

export interface ConnectionCheckRecord {
  /** ISO time of the most recent Test that passed. */
  verifiedAt?: string;
  lastCheck?: LastCheck;
}

function checksPath(): string {
  return patchworkPath("tokens", "connection-checks.json");
}

function isIsoString(v: unknown): v is string {
  return typeof v === "string" && !Number.isNaN(Date.parse(v));
}

/**
 * Reader whitelist: a field is kept only when it has the shape this module
 * writes. Anything else in the file is ignored rather than passed through.
 */
function sanitizeRecord(raw: unknown): ConnectionCheckRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: ConnectionCheckRecord = {};
  if (isIsoString(r.verifiedAt)) out.verifiedAt = r.verifiedAt;
  const lc = r.lastCheck as Record<string, unknown> | undefined;
  if (lc && typeof lc === "object" && isIsoString(lc.at)) {
    if (lc.ok === true) {
      out.lastCheck = { at: lc.at, ok: true };
    } else if (lc.ok === false) {
      out.lastCheck = {
        at: lc.at,
        ok: false,
        ...(typeof lc.reason === "string" &&
          REASONS.has(lc.reason) && {
            reason: lc.reason as CheckFailureReason,
          }),
      };
    }
  }
  return out.verifiedAt || out.lastCheck ? out : null;
}

/** Every recorded check, keyed by connector id. Missing/corrupt file ⇒ {}. */
export function readConnectionChecks(): Record<string, ConnectionCheckRecord> {
  const p = checksPath();
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, ConnectionCheckRecord> = {};
    for (const [id, raw] of Object.entries(parsed as Record<string, unknown>)) {
      const rec = sanitizeRecord(raw);
      if (rec) out[id] = rec;
    }
    return out;
  } catch {
    return {};
  }
}

function writeConnectionChecks(
  all: Record<string, ConnectionCheckRecord>,
): void {
  const p = checksPath();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // best effort (e.g. Windows)
  }
  renameSync(tmp, p);
}

/** Record the outcome of a connection Test for `id`. */
export function recordConnectionCheck(
  id: string,
  ok: boolean,
  reason?: CheckFailureReason,
  now: Date = new Date(),
): void {
  const all = readConnectionChecks();
  const prev = all[id] ?? {};
  const at = now.toISOString();
  all[id] = {
    ...(ok
      ? { verifiedAt: at }
      : prev.verifiedAt && { verifiedAt: prev.verifiedAt }),
    lastCheck: ok
      ? { at, ok: true }
      : { at, ok: false, ...(reason && { reason }) },
  };
  writeConnectionChecks(all);
}

/** Drop everything recorded for `id` — its credential was replaced or removed. */
export function clearConnectionCheck(id: string): void {
  const all = readConnectionChecks();
  if (!(id in all)) return;
  delete all[id];
  writeConnectionChecks(all);
}

/** `/connections/<id>/test` → `<id>`; `/connections/<id>[/...]` → `<id>`. */
export function connectorIdFromPath(pathname: string): string | null {
  const m = /^\/connections\/([a-z0-9-]+)(?:\/|$)/.exec(pathname);
  return m ? (m[1] ?? null) : null;
}

/**
 * Turn a Test handler's result into a check outcome, or null when there is
 * nothing to record (no credential stored, so nothing was tested). Every Test
 * handler answers `{ ok: boolean, ... }`; a non-2xx status or anything other
 * than `ok: true` is a failure.
 */
export function checkFromTestResult(result: {
  status: number;
  body: string;
}): { ok: true } | { ok: false; reason: CheckFailureReason } | null {
  let parsed: Record<string, unknown> | null = null;
  try {
    const v = JSON.parse(result.body) as unknown;
    if (v && typeof v === "object") parsed = v as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  if (result.status < 400 && parsed?.ok === true) return { ok: true };
  const said = `${parsed?.error ?? ""} ${parsed?.message ?? ""}`;
  if (/\bnot connected\b/i.test(said)) return null;
  if (result.status >= 500) return { ok: false, reason: "error" };
  return { ok: false, reason: "failed" };
}

/**
 * Called with every `POST /connections/<id>/test` result before it is sent.
 * Records the outcome, then hands the result back unchanged. Recording is
 * best effort: a status file that cannot be written must never turn a Test
 * the operator ran into an error.
 */
export function recordTestOutcome<T extends { status: number; body: string }>(
  pathname: string,
  result: T,
): T {
  const id = connectorIdFromPath(pathname);
  if (!id) return result;
  try {
    const outcome = checkFromTestResult(result);
    if (outcome) {
      recordConnectionCheck(
        id,
        outcome.ok,
        outcome.ok ? undefined : outcome.reason,
      );
    }
  } catch {
    // best effort — see above
  }
  return result;
}

/**
 * Called after a request that replaced or removed the credential for the
 * connector named in `pathname` (connect, OAuth callback, disconnect). Only a
 * successful one counts: a rejected callback changed nothing stored.
 */
export function afterCredentialChange<T extends { status: number }>(
  pathname: string,
  result: T,
): T {
  const id = connectorIdFromPath(pathname);
  if (id && result.status < 400) {
    try {
      clearConnectionCheck(id);
    } catch {
      // best effort
    }
  }
  return result;
}

// ── Stored connection metadata ───────────────────────────────────────────────

/**
 * Fields connectors store at connect time that name the connected account or
 * workspace, in the order preferred for display. Only these are read; a
 * credential field is never a label.
 */
const ACCOUNT_LABEL_FIELDS = [
  "workspaceName",
  "workspace",
  "team_name",
  "portalName",
  "orgName",
  "businessName",
  "login",
  "username",
  "userHandle",
  "userName",
  "email",
  "userEmail",
] as const;

export interface StoredConnectionMeta {
  connectedAt?: string;
  account?: string;
}

/**
 * True when `ts` is a real recorded time: parseable and earlier than
 * `readStartedAt`. Several `loadTokens()` implementations synthesise
 * `connected_at: new Date()` for an environment key; such a value is created
 * during the read and so is never earlier than the moment the read began.
 */
export function isRecordedTime(
  ts: unknown,
  readStartedAt: number,
): ts is string {
  if (typeof ts !== "string") return false;
  const t = Date.parse(ts);
  return !Number.isNaN(t) && t < readStartedAt;
}

/**
 * Read `connectedAt` and an account label from a connector's stored token
 * object. Never fills a missing value.
 */
export function storedConnectionMeta(
  stored: unknown,
  readStartedAt: number,
): StoredConnectionMeta {
  if (!stored || typeof stored !== "object") return {};
  const s = stored as Record<string, unknown>;
  const out: StoredConnectionMeta = {};
  if (isRecordedTime(s.connected_at, readStartedAt)) {
    out.connectedAt = s.connected_at;
  }
  for (const field of ACCOUNT_LABEL_FIELDS) {
    const v = s[field];
    if (typeof v === "string" && v.trim().length > 0) {
      out.account = v.trim().slice(0, 200);
      break;
    }
  }
  return out;
}

// ── Revoke outcome ───────────────────────────────────────────────────────────

/**
 * What a disconnect knows about the credential at the provider:
 *   - `yes`         — the provider accepted the revoke request.
 *   - `failed`      — a revoke was due and did not succeed (network error,
 *                     non-2xx, provider said no, or it could not be sent).
 *                     The credential may still be live at the provider.
 *   - `unsupported` — this connector has no provider revoke.
 * The local credential is removed in every case.
 */
export type RevokeOutcome = "yes" | "failed" | "unsupported";

/** POST a revoke request; any thrown error or non-2xx is `failed`. */
export async function attemptRevoke(
  url: string,
  init: RequestInit,
  accepted: (res: Response) => Promise<boolean> | boolean = (res) => res.ok,
): Promise<RevokeOutcome> {
  try {
    const res = await fetch(url, init);
    return (await accepted(res)) ? "yes" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * Connectors whose disconnect attempts a provider revoke. Every other
 * connector reports `revoked: "unsupported"`. A guard test checks this set
 * against the disconnect handlers' source, so a connector that starts (or
 * stops) revoking cannot be misreported.
 */
export const REVOKING_CONNECTORS: ReadonlySet<string> = new Set([
  "gmail",
  "google-calendar",
  "google-drive",
  "google-docs",
  "slack",
  "discord",
  "gitlab",
  "asana",
  "salesforce",
  "github",
  "linear",
  "sentry",
]);

/**
 * Normalise a `DELETE /connections/<id>` result. A revoking connector's
 * handler states its own `revoked` (absent when nothing was stored, so there
 * was nothing to revoke); every other connector is `unsupported`. `ok` stays
 * for older clients.
 */
export function disconnectResponse<T extends { status: number; body: string }>(
  pathname: string,
  result: T,
): T {
  const id = connectorIdFromPath(pathname);
  if (!id || result.status >= 400) return result;
  // The credential is gone, so is anything recorded about it.
  afterCredentialChange(pathname, result);
  let parsed: Record<string, unknown>;
  try {
    const v = JSON.parse(result.body) as unknown;
    if (!v || typeof v !== "object") return result;
    parsed = v as Record<string, unknown>;
  } catch {
    return result;
  }
  if (parsed.ok !== true) return result;
  const body: Record<string, unknown> = { ...parsed, removed: true };
  if (!REVOKING_CONNECTORS.has(id)) body.revoked = "unsupported";
  return { ...result, body: JSON.stringify(body) };
}

/** Body for a revoking connector's disconnect. */
export function disconnectBody(revoked: RevokeOutcome | undefined): string {
  return JSON.stringify({
    ok: true,
    removed: true,
    ...(revoked && { revoked }),
  });
}
