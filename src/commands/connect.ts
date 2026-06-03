/**
 * `patchwork connect` — the connector front-door.
 *
 * A thin CLI→HTTP shim over the bridge's already-built `/connections/*`
 * routes (see src/connectorRoutes.ts). 23 connector error messages already
 * tell users to "Run: patchwork connect <vendor>"; this is that command.
 *
 * NO new bridge or connector logic lives here — every verb maps to one
 * existing HTTP route:
 *   - list       → GET    /connections                (Bearer)
 *   - <vendor>   → GET    /connections/<id>/auth       (OAuth, 302 Location)
 *              or  POST   /connections/<id>/connect    (PAT, {token})
 *   - test       → POST   /connections/<id>/test       (health probe)
 *   - disconnect → DELETE /connections/<id>            (revoke)
 *
 * Bridge discovery + Bearer auth mirror src/commands/task.ts. All side
 * effects (lock discovery, fetch, stdout/stderr, exit) are injectable so
 * the command is unit-testable without a live bridge.
 */

import {
  CONNECTORS,
  type ConnectorDescriptor,
} from "../connectors/connectorRegistry.js";

interface LockInfo {
  port: number;
  authToken: string;
}

export interface ConnectDeps {
  /** Resolve a running bridge. `port` selects a specific lock. */
  findBridgeLock: (port?: number) => LockInfo | null;
  /** HTTP transport (defaults to global fetch). */
  fetchFn: typeof fetch;
  /** Connector roster (defaults to the shared registry). */
  connectors: readonly ConnectorDescriptor[];
  /** stdout sink. */
  write: (s: string) => void;
  /** stderr sink. */
  writeErr: (s: string) => void;
  /** Process exit (capture-only in tests). */
  exit: (code: number) => void;
}

// ── live `/connections` response shape (id + status only) ────────────────────

type ConnectionStatus = "connected" | "disconnected" | "needs_reauth";

interface LiveConnector {
  id?: string;
  status?: string;
  lastSync?: string;
}

interface ConnectionsListResponse {
  connectors?: LiveConnector[];
}

/** Generic `{ ok, error, ... }` body returned by connect/test/delete routes. */
interface ConnectorActionResponse {
  ok?: boolean;
  error?: string;
  workspace?: string;
  [k: string]: unknown;
}

const TIMEOUT_MS = 10_000;

// ── arg parsing ──────────────────────────────────────────────────────────────

interface ParsedArgs {
  positional: string[];
  json: boolean;
  urlOnly: boolean;
  help: boolean;
  token?: string;
  port?: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    positional: [],
    json: false,
    urlOnly: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--json") out.json = true;
    else if (a === "--url-only") out.urlOnly = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--token") {
      const next = argv[++i];
      if (next !== undefined) out.token = next;
    } else if (a === "--port") {
      const next = argv[++i];
      if (next !== undefined) out.port = Number(next);
    } else if (!a.startsWith("-")) {
      out.positional.push(a);
    }
  }
  return out;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function bearer(lock: LockInfo): Record<string, string> {
  return { Authorization: `Bearer ${lock.authToken}` };
}

function statusGlyph(status: ConnectionStatus): string {
  if (status === "connected") return "✓ connected";
  if (status === "needs_reauth") return "⚠ needs reauth";
  return "✗ not connected";
}

function normalizeStatus(raw: string | undefined): ConnectionStatus {
  if (raw === "connected" || raw === "needs_reauth") return raw;
  return "disconnected";
}

/** Levenshtein distance for "did you mean" suggestions. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  const curr: number[] = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const del = (prev[j] ?? 0) + 1;
      const ins = (curr[j - 1] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[n] ?? 0;
}

function suggestVendor(
  input: string,
  connectors: readonly ConnectorDescriptor[],
): string | undefined {
  let best: { id: string; dist: number } | undefined;
  for (const c of connectors) {
    const dist = editDistance(input, c.id);
    if (!best || dist < best.dist) best = { id: c.id, dist };
  }
  // Only suggest when reasonably close.
  return best && best.dist <= 3 ? best.id : undefined;
}

function resolveLock(deps: ConnectDeps, port?: number): LockInfo | null {
  const lock = deps.findBridgeLock(port);
  if (!lock) {
    deps.writeErr(
      "No running bridge — start it with: patchwork start\n" +
        (port !== undefined
          ? `(checked port ${port}; lock missing, IDE-owned, or dead)\n`
          : ""),
    );
    deps.exit(1);
    return null;
  }
  return lock;
}

async function readJson<T>(res: Response): Promise<T | null> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function networkError(deps: ConnectDeps, err: unknown, json: boolean): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (json) {
    deps.write(`${JSON.stringify({ ok: false, error: msg })}\n`);
  }
  deps.writeErr(`Error contacting bridge: ${msg}\n`);
  deps.exit(1);
}

// ── verbs ────────────────────────────────────────────────────────────────────

async function runList(deps: ConnectDeps, args: ParsedArgs): Promise<void> {
  const lock = resolveLock(deps, args.port);
  if (!lock) return;

  let live: ConnectionsListResponse | null;
  try {
    const res = await deps.fetchFn(
      `http://127.0.0.1:${lock.port}/connections`,
      {
        method: "GET",
        headers: bearer(lock),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    live = await readJson<ConnectionsListResponse>(res);
  } catch (err) {
    networkError(deps, err, args.json);
    return;
  }

  // Join live status onto the full registry roster so connectors absent
  // from the response render as not-connected rather than vanishing.
  const statusById = new Map<string, ConnectionStatus>();
  for (const c of live?.connectors ?? []) {
    if (c.id) statusById.set(c.id, normalizeStatus(c.status));
  }

  const rows = deps.connectors.map((c) => ({
    id: c.id,
    label: c.label,
    authKind: c.authKind,
    status: statusById.get(c.id) ?? ("disconnected" as ConnectionStatus),
  }));

  if (args.json) {
    deps.write(`${JSON.stringify({ connectors: rows })}\n`);
    deps.exit(0);
    return;
  }

  // Connected first, then needs_reauth, then disconnected; stable by label.
  const rank: Record<ConnectionStatus, number> = {
    connected: 0,
    needs_reauth: 1,
    disconnected: 2,
  };
  rows.sort(
    (a, b) => rank[a.status] - rank[b.status] || a.label.localeCompare(b.label),
  );

  const idWidth = Math.max(...rows.map((r) => r.id.length), 2);
  deps.write("Connectors:\n");
  for (const r of rows) {
    deps.write(
      `  ${r.id.padEnd(idWidth)}  ${statusGlyph(r.status).padEnd(16)}` +
        `${r.label} (${r.authKind})\n`,
    );
  }
  deps.exit(0);
}

async function runOauth(
  deps: ConnectDeps,
  descriptor: ConnectorDescriptor,
  args: ParsedArgs,
): Promise<void> {
  const lock = resolveLock(deps, args.port);
  if (!lock) return;

  let res: Response;
  try {
    res = await deps.fetchFn(
      `http://127.0.0.1:${lock.port}/connections/${descriptor.id}/auth`,
      {
        method: "GET",
        headers: bearer(lock),
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
  } catch (err) {
    networkError(deps, err, args.json);
    return;
  }

  const location = res.headers.get("location");
  if (res.status === 302 && location) {
    if (args.json) {
      deps.write(`${JSON.stringify({ ok: true, url: location })}\n`);
    } else if (args.urlOnly) {
      deps.write(`${location}\n`);
    } else {
      deps.write(
        `Open this URL in your browser to authorize ${descriptor.label}:\n` +
          `  ${location}\n`,
      );
    }
    deps.exit(0);
    return;
  }

  // No redirect — surface the bridge's error body if present.
  const body = await readJson<ConnectorActionResponse>(res);
  const detail = body?.error ?? `HTTP ${res.status}`;
  if (args.json) {
    deps.write(`${JSON.stringify({ ok: false, error: detail })}\n`);
  }
  deps.writeErr(
    `Could not start ${descriptor.label} authorization: ${detail}\n`,
  );
  deps.exit(1);
}

async function runPatConnect(
  deps: ConnectDeps,
  descriptor: ConnectorDescriptor,
  args: ParsedArgs,
): Promise<void> {
  if (!args.token) {
    // No token supplied — print honest instructions rather than guessing.
    deps.write(
      `${descriptor.label} is a token (PAT) connector.\n` +
        `  Pass a token directly:\n` +
        `    patchwork connect ${descriptor.id} --token <TOKEN>\n` +
        `  Some connectors need more than one field (e.g. Jira/Confluence/` +
        `Zendesk/Datadog need a URL + email + token).\n` +
        `  For those, use the dashboard /connections page to connect.\n`,
    );
    deps.exit(0);
    return;
  }

  const lock = resolveLock(deps, args.port);
  if (!lock) return;

  let res: Response;
  try {
    res = await deps.fetchFn(
      `http://127.0.0.1:${lock.port}/connections/${descriptor.id}/connect`,
      {
        method: "POST",
        headers: { ...bearer(lock), "Content-Type": "application/json" },
        body: JSON.stringify({ token: args.token }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
  } catch (err) {
    networkError(deps, err, args.json);
    return;
  }

  const body = await readJson<ConnectorActionResponse>(res);
  const ok = res.status >= 200 && res.status < 300 && body?.ok !== false;
  if (args.json) {
    deps.write(`${JSON.stringify({ ok, ...(body ?? {}) })}\n`);
  } else if (ok) {
    const where = body?.workspace ? ` (workspace: ${body.workspace})` : "";
    deps.write(`✓ Connected ${descriptor.label}${where}\n`);
  } else {
    deps.writeErr(
      `✗ Failed to connect ${descriptor.label}: ${body?.error ?? `HTTP ${res.status}`}\n`,
    );
  }
  deps.exit(ok ? 0 : 1);
}

async function runTest(
  deps: ConnectDeps,
  vendor: string | undefined,
  args: ParsedArgs,
): Promise<void> {
  const descriptor = resolveVendor(deps, vendor);
  if (!descriptor) return;
  const lock = resolveLock(deps, args.port);
  if (!lock) return;

  let res: Response;
  try {
    res = await deps.fetchFn(
      `http://127.0.0.1:${lock.port}/connections/${descriptor.id}/test`,
      {
        method: "POST",
        headers: bearer(lock),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
  } catch (err) {
    networkError(deps, err, args.json);
    return;
  }

  const body = await readJson<ConnectorActionResponse>(res);
  const ok = res.status >= 200 && res.status < 300 && body?.ok !== false;
  if (args.json) {
    deps.write(`${JSON.stringify({ ok, ...(body ?? {}) })}\n`);
  } else if (ok) {
    deps.write(`✓ ${descriptor.label} is healthy\n`);
  } else {
    deps.writeErr(
      `✗ ${descriptor.label} test failed: ${body?.error ?? `HTTP ${res.status}`}\n`,
    );
  }
  deps.exit(ok ? 0 : 1);
}

async function runDisconnect(
  deps: ConnectDeps,
  vendor: string | undefined,
  args: ParsedArgs,
): Promise<void> {
  const descriptor = resolveVendor(deps, vendor);
  if (!descriptor) return;
  const lock = resolveLock(deps, args.port);
  if (!lock) return;

  let res: Response;
  try {
    res = await deps.fetchFn(
      `http://127.0.0.1:${lock.port}/connections/${descriptor.id}`,
      {
        method: "DELETE",
        headers: bearer(lock),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
  } catch (err) {
    networkError(deps, err, args.json);
    return;
  }

  const body = await readJson<ConnectorActionResponse>(res);
  const ok = res.status >= 200 && res.status < 300 && body?.ok !== false;
  if (args.json) {
    deps.write(`${JSON.stringify({ ok, ...(body ?? {}) })}\n`);
  } else if (ok) {
    deps.write(`✓ Disconnected ${descriptor.label}\n`);
  } else {
    deps.writeErr(
      `✗ Failed to disconnect ${descriptor.label}: ${body?.error ?? `HTTP ${res.status}`}\n`,
    );
  }
  deps.exit(ok ? 0 : 1);
}

/** Resolve a vendor id to its descriptor, or emit an error + exit(1). */
function resolveVendor(
  deps: ConnectDeps,
  vendor: string | undefined,
): ConnectorDescriptor | undefined {
  if (!vendor) {
    deps.writeErr("Missing connector id.\n");
    deps.exit(1);
    return undefined;
  }
  const descriptor = deps.connectors.find((c) => c.id === vendor);
  if (!descriptor) {
    const hint = suggestVendor(vendor, deps.connectors);
    const validIds = deps.connectors.map((c) => c.id).join(", ");
    deps.writeErr(
      `Unknown connector "${vendor}".\n` +
        (hint ? `Did you mean "${hint}"?\n` : "") +
        `Valid ids: ${validIds}\n`,
    );
    deps.exit(1);
    return undefined;
  }
  return descriptor;
}

function printHelp(deps: ConnectDeps): void {
  deps.write(
    "Usage: patchwork connect [<vendor>|list|test <vendor>|disconnect <vendor>]\n" +
      "\n" +
      "  connect [list] [--json]            List connectors + connection status\n" +
      "  connect <vendor> [--url-only]      OAuth: print the authorize URL to open\n" +
      "  connect <vendor> --token <TOKEN>   PAT: paste a token to connect\n" +
      "  connect test <vendor> [--json]     Health-probe a connector\n" +
      "  connect disconnect <vendor>        Revoke a connector\n" +
      "\n" +
      "  --port <n>   Target a specific bridge lock\n" +
      "  --url-only   Print only the OAuth URL (headless/CI)\n" +
      "  --json       Machine-readable output\n",
  );
  deps.exit(0);
}

// ── entrypoint ───────────────────────────────────────────────────────────────

const DEFAULT_DEPS: Omit<ConnectDeps, "findBridgeLock"> = {
  fetchFn: globalThis.fetch,
  connectors: CONNECTORS,
  write: (s) => process.stdout.write(s),
  writeErr: (s) => process.stderr.write(s),
  exit: (c) => process.exit(c),
};

/**
 * `patchwork connect ...` dispatcher.
 *
 * `deps` is fully injectable for tests. In production, callers pass
 * `findBridgeLock` (from src/commands/task.ts's lock helper) plus any
 * overrides; everything else defaults to real process I/O.
 */
export async function runConnect(
  argv: string[],
  deps: Partial<ConnectDeps> & Pick<ConnectDeps, "findBridgeLock">,
): Promise<void> {
  const resolved: ConnectDeps = { ...DEFAULT_DEPS, ...deps };
  const args = parseArgs(argv);

  if (args.help) {
    printHelp(resolved);
    return;
  }

  const verb = args.positional[0];

  // Bare `connect` or `connect list` → list.
  if (verb === undefined || verb === "list") {
    await runList(resolved, args);
    return;
  }

  if (verb === "test") {
    await runTest(resolved, args.positional[1], args);
    return;
  }

  if (verb === "disconnect") {
    await runDisconnect(resolved, args.positional[1], args);
    return;
  }

  // Otherwise `verb` is a vendor id: OAuth (auth) or PAT (connect).
  const descriptor = resolveVendor(resolved, verb);
  if (!descriptor) return;

  if (descriptor.authKind === "oauth" && descriptor.supports.auth) {
    await runOauth(resolved, descriptor, args);
    return;
  }
  if (descriptor.supports.connect) {
    await runPatConnect(resolved, descriptor, args);
    return;
  }
  // OAuth-capable PAT connectors (auth:true but pat): prefer the token path.
  if (descriptor.supports.auth) {
    await runOauth(resolved, descriptor, args);
    return;
  }

  resolved.writeErr(
    `Connector "${descriptor.id}" does not support an interactive connect flow.\n`,
  );
  resolved.exit(1);
}
