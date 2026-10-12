/**
 * Is the Claude sign-in this bridge holds still ACCEPTED?
 *
 * `claude auth status` (what `GET /auth/claude/status` relays) reads local
 * state: it says a sign-in is PRESENT, not that Anthropic still accepts it.
 * Observed live: status reported `loggedIn: true` while every agent step was
 * refused with "OAuth access token has been revoked". The CLI offers no free
 * local check that validates the token, and a test model call costs money, so
 * this uses evidence the runtime already has: the refusal itself.
 *
 * A Claude task refused for authentication records WHEN. Status then reports
 * the sign-in as needing renewal whenever that refusal is newer than every
 * later sign of a working sign-in:
 *   - the credentials file's mtime (Claude Code rewrites it on sign-in), when
 *     the file exists (macOS keeps the login in the keychain instead);
 *   - the last sign-in completed through `/auth/claude/complete`;
 *   - the last Claude task that succeeded.
 *
 * Holds timestamps only — never a credential, a prompt or any task output.
 * Fail-soft both ways: an unreadable marker reads as "no evidence" (status
 * falls back to credential presence, the previous behaviour), and a marker
 * that cannot be written never fails the task that produced the evidence.
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { patchworkPath } from "./patchworkHome.js";
import { isAgentAuthFailure } from "./recipes/haltCategory.js";

export interface ClaudeAuthHealthState {
  /** Epoch ms of the most recent Claude refusal for authentication. */
  lastAuthFailureAt?: number;
  /** Epoch ms of the last sign-in completed through the bridge's relay. */
  lastSignInAt?: number;
  /** Epoch ms of the last Claude task that succeeded after a refusal. */
  lastSuccessAt?: number;
}

const FILE = "claude_auth_health.json";

function statePath(): string {
  return patchworkPath(FILE);
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function readClaudeAuthHealth(): ClaudeAuthHealthState {
  try {
    const raw = JSON.parse(readFileSync(statePath(), "utf8")) as Record<
      string,
      unknown
    >;
    const out: ClaudeAuthHealthState = {};
    const f = num(raw.lastAuthFailureAt);
    const s = num(raw.lastSignInAt);
    const ok = num(raw.lastSuccessAt);
    if (f !== undefined) out.lastAuthFailureAt = f;
    if (s !== undefined) out.lastSignInAt = s;
    if (ok !== undefined) out.lastSuccessAt = ok;
    return out;
  } catch {
    return {};
  }
}

function writeState(state: ClaudeAuthHealthState): void {
  try {
    const p = statePath();
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, p);
  } catch {
    // Best-effort: losing this marker only means status falls back to
    // credential presence, which is what it reported before.
  }
}

/** A Claude task was refused because its sign-in was not accepted. */
export function recordClaudeAuthFailure(now = Date.now()): void {
  const prev = readClaudeAuthHealth();
  writeState({ ...prev, lastAuthFailureAt: now });
}

/** A sign-in completed through the bridge's relay. Clears any refusal. */
export function recordClaudeSignIn(now = Date.now()): void {
  writeState({ lastSignInAt: now });
}

/**
 * A Claude task succeeded, so the sign-in works. Writes only when there is a
 * refusal to clear — a successful task is the common case and must not touch
 * the disk every time.
 */
export function recordClaudeAgentSuccess(now = Date.now()): void {
  const prev = readClaudeAuthHealth();
  if (prev.lastAuthFailureAt === undefined) return;
  if (now < prev.lastAuthFailureAt) return;
  const { lastAuthFailureAt: _cleared, ...rest } = prev;
  writeState({ ...rest, lastSuccessAt: now });
}

/**
 * Feed one finished Claude orchestrator task into the marker. Uses the same
 * classifier as the `agent_auth` halt category, so "the run halted for
 * sign-in" and "status says sign in again" cannot disagree. Only the head of
 * the output is read: the CLI's refusal IS its whole result text, while a
 * long output that merely mentions authentication somewhere is not one.
 */
export function observeClaudeTaskForAuth(
  task: { status?: string; errorMessage?: string; output?: string },
  now = Date.now(),
): void {
  if (task.status === "done") {
    recordClaudeAgentSuccess(now);
    return;
  }
  if (task.status !== "error") return;
  const text = `${task.errorMessage ?? ""} ${(task.output ?? "").slice(0, 400)}`;
  if (isAgentAuthFailure(text)) recordClaudeAuthFailure(now);
}

/** mtime of Claude Code's credentials file, when it keeps one on disk. */
export function claudeCredentialsUpdatedAt(): number | undefined {
  const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  try {
    return statSync(join(dir, ".credentials.json")).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Pure: is the most recent Claude refusal newer than every sign that the
 * sign-in works? Exported for tests and for any other reader (doctor).
 */
export function needsSignInAgain(
  state: ClaudeAuthHealthState,
  credentialsUpdatedAt: number | undefined,
): boolean {
  const failure = state.lastAuthFailureAt;
  if (failure === undefined) return false;
  const latestGood = Math.max(
    credentialsUpdatedAt ?? 0,
    state.lastSignInAt ?? 0,
    state.lastSuccessAt ?? 0,
  );
  return failure > latestGood;
}
