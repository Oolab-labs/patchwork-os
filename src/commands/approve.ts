/**
 * `patchwork approve <callId>` / `patchwork reject <callId>`.
 *
 * ## Why this exists
 *
 * The dashboard has two buttons that copy `patchwork approve <callId>` and
 * `patchwork approve --edit <callId>` to the clipboard
 * (dashboard/src/app/approvals/page.tsx). Neither command existed: running the
 * copied string printed `Unknown command: 'approve'. Did you mean: approvals?`
 * — `approvals` being an unrelated read-only KPI report. So the product told
 * the operator to run something that has never worked.
 *
 * It also matters beyond the broken button. Every approval today is decided
 * through the dashboard or a phone notification. If either becomes unavailable
 * — the dashboard is down, the push relay is unreachable, or a future change
 * starts REFUSING approvals — there is no other way to decide a queued action,
 * and a queued action blocks the recipe waiting on it. A terminal path is the
 * fallback that has to exist before anything can ever refuse.
 *
 * ## A shim, and nothing more
 *
 * No new approval logic lives here. Each verb maps to one route the bridge
 * already serves (src/approvalHttp.ts):
 *   - approve → POST /approve/:callId
 *   - reject  → POST /reject/:callId   (optional `{ reason }` body)
 *   - --review reads GET /approvals first, purely to show the operator what
 *     they are about to decide.
 *
 * Bridge discovery and Bearer auth mirror src/commands/connect.ts. Every side
 * effect is injected so this is testable without a live bridge.
 *
 * ## `--edit` cannot do what its name promises
 *
 * The dashboard advertises "Edit & approve". There is NO param-editing
 * capability anywhere in the bridge: `POST /approve/:callId` ignores the
 * request body entirely, and nothing in the tree patches a pending approval's
 * params. The flag was aspirational.
 *
 * It is accepted here anyway, because the copied command must work rather than
 * error. But it does NOT silently pretend: it prints that parameters cannot be
 * modified and then behaves as `--review`. Quietly treating `--edit` as a
 * successful edit would be the worse failure — the operator would believe they
 * had changed an action's parameters and approve the original.
 */

/** The subset of the bridge lock file this command needs. */
export interface ApproveLockInfo {
  port: number;
  authToken: string;
}

/** One pending approval as `GET /approvals` returns it. */
interface PendingEntry {
  callId?: string;
  toolName?: string;
  tier?: string;
  summary?: string;
  recipeName?: string;
  params?: unknown;
  requestedAt?: number;
}

export interface ApproveDeps {
  findBridgeLock: (port?: number) => ApproveLockInfo | null;
  fetchFn: typeof fetch;
  write: (s: string) => void;
  writeErr: (s: string) => void;
  exit: (code: number) => void;
  /** Whether stdin is a terminal — gates the confirmation prompt. */
  isTTY: boolean;
  /** Ask a yes/no question. Only called when `isTTY` is true. */
  confirm: (question: string) => Promise<boolean>;
}

/**
 * The route patterns are `/^\/(approve|reject)\/([A-Za-z0-9-]+)$/`. An id
 * outside that set cannot match, so the bridge would answer 404 — technically
 * correct and useless to read, because "unknown callId" and "you pasted
 * something that is not a callId" are different problems with different fixes.
 * Checked here so the message names the real one.
 */
const CALL_ID_RE = /^[A-Za-z0-9-]+$/;

function usage(action: "approve" | "reject"): string {
  const extra =
    action === "reject" ? "\n  --reason <text>  record why (audit trail)" : "";
  return (
    `usage: patchwork ${action} <callId> [--review] [--json]${extra}\n\n` +
    `  --review   print the queued action and confirm before deciding\n` +
    `  --json     machine-readable result\n\n` +
    `List what is pending with: patchwork approvals\n`
  );
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  // A flag whose value is missing or is itself a flag was almost certainly a
  // typo. Returning undefined would silently drop it.
  if (v === undefined || v.startsWith("--")) return undefined;
  return v;
}

/** Render one pending entry for the review prompt. */
function describeEntry(e: PendingEntry): string {
  const lines: string[] = [];
  lines.push(`  tool:    ${e.toolName ?? "(unknown)"}`);
  if (e.tier) lines.push(`  tier:    ${e.tier}`);
  if (e.recipeName) lines.push(`  recipe:  ${e.recipeName}`);
  if (e.summary) lines.push(`  summary: ${e.summary}`);
  if (e.params !== undefined) {
    let rendered: string;
    try {
      rendered = JSON.stringify(e.params, null, 2) ?? String(e.params);
    } catch {
      rendered = "(unserialisable)";
    }
    // Indent every line so the params block cannot be mistaken for the
    // surrounding prose when it spans many lines.
    lines.push("  params:");
    for (const l of rendered.split("\n")) lines.push(`    ${l}`);
  }
  return lines.join("\n");
}

export async function runApproveCommand(
  action: "approve" | "reject",
  argv: string[],
  deps: ApproveDeps,
): Promise<void> {
  const wantJson = argv.includes("--json");
  const wantEdit = argv.includes("--edit");
  const wantReview = argv.includes("--review") || wantEdit;
  const reason = action === "reject" ? flagValue(argv, "--reason") : undefined;

  const positional = argv.filter((a, i) => {
    if (a.startsWith("--")) return false;
    // Drop the value that belongs to --reason.
    const prev = argv[i - 1];
    if (prev === "--reason") return false;
    return true;
  });
  const callId = positional[0];

  if (!callId) {
    deps.writeErr(usage(action));
    deps.exit(1);
    return;
  }
  if (!CALL_ID_RE.test(callId)) {
    deps.writeErr(
      `[${action}] '${callId}' is not a callId (expected letters, digits and hyphens).\n` +
        `  Copy one from the dashboard, or run: patchwork approvals\n`,
    );
    deps.exit(1);
    return;
  }

  const lock = deps.findBridgeLock();
  if (!lock) {
    deps.writeErr(
      `[${action}] no running bridge found in ~/.claude/ide/.\n` +
        `  An approval is held in the bridge's memory, so there is nothing to decide\n` +
        `  while it is stopped. Start it with: patchwork start\n`,
    );
    deps.exit(1);
    return;
  }

  const base = `http://127.0.0.1:${lock.port}`;
  const auth = { Authorization: `Bearer ${lock.authToken}` };

  if (wantEdit) {
    // Say it plainly rather than letting the flag imply a capability. See the
    // module header: the bridge ignores the body on /approve entirely.
    deps.writeErr(
      `[${action}] --edit cannot modify parameters — the bridge has no such capability.\n` +
        `  Showing the queued action for review instead; approving sends it unchanged.\n`,
    );
  }

  if (wantReview) {
    let entry: PendingEntry | undefined;
    try {
      const res = await deps.fetchFn(`${base}/approvals`, { headers: auth });
      if (res.ok) {
        const list = (await res.json()) as PendingEntry[];
        if (Array.isArray(list)) {
          entry = list.find((e) => e?.callId === callId);
        }
      }
    } catch {
      /* fall through — review is a courtesy, not a gate */
    }

    if (!entry) {
      deps.writeErr(
        `[${action}] ${callId} is not in the pending list. It may have been decided\n` +
          `  already, or expired. Continuing would 404 or 409.\n`,
      );
      deps.exit(1);
      return;
    }

    deps.write(`About to ${action}:\n${describeEntry(entry)}\n`);

    if (!deps.isTTY) {
      // Same discipline as `members set-password`: a confirmation that cannot
      // be given must not be assumed. Refusing a pipe is the safe default for
      // a command whose whole purpose is a deliberate human decision.
      deps.writeErr(
        `[${action}] --review needs an interactive terminal to confirm.\n` +
          `  Drop --review to ${action} without the prompt.\n`,
      );
      deps.exit(1);
      return;
    }
    const ok = await deps.confirm(`${action} this action? [y/N] `);
    if (!ok) {
      deps.write(`Cancelled — nothing was ${action}d.\n`);
      deps.exit(0);
      return;
    }
  }

  const url = `${base}/${action}/${callId}`;
  let res: Response;
  try {
    res = await deps.fetchFn(url, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(reason !== undefined ? { reason } : {}),
    });
  } catch (err) {
    deps.writeErr(
      `[${action}] could not reach the bridge at ${base}: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    deps.exit(1);
    return;
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* a non-JSON body is reported via status alone below */
  }

  if (wantJson) {
    deps.write(`${JSON.stringify({ status: res.status, ...body }, null, 2)}\n`);
    deps.exit(res.ok ? 0 : 1);
    return;
  }

  if (res.ok) {
    const decision = typeof body.decision === "string" ? body.decision : action;
    deps.write(`${decision === "allow" ? "Approved" : "Rejected"} ${callId}\n`);
    deps.exit(0);
    return;
  }

  // Distinguish the three failures an operator can actually act on. A generic
  // "request failed" would send them to check the bridge when the real answer
  // is that a colleague already decided it.
  if (res.status === 409 && body.error === "already_decided") {
    deps.writeErr(
      `[${action}] ${callId} was already decided (${String(body.decision)}).\n` +
        `  Nothing changed. A concurrent dashboard or phone action got there first.\n`,
    );
  } else if (res.status === 404) {
    deps.writeErr(
      `[${action}] ${callId} is not pending — it may have expired or never existed.\n` +
        `  Run: patchwork approvals\n`,
    );
  } else if (res.status === 401) {
    deps.writeErr(
      `[${action}] the bridge rejected this credential (401). The lock file's token\n` +
        `  may be stale — restart the bridge, or check ~/.claude/ide/.\n`,
    );
  } else {
    deps.writeErr(
      `[${action}] bridge returned ${res.status}: ${
        typeof body.error === "string" ? body.error : "(no error field)"
      }\n`,
    );
  }
  deps.exit(1);
}
