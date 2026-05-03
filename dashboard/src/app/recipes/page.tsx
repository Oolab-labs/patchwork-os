"use client";
import React from "react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { apiPath } from "@/lib/api";
import { ConnectorHealthPanel } from "@/components/ConnectorHealthPanel";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";

interface BridgeStatusForRecipes {
  patchwork?: { port?: number };
  port?: number;
}

/** Build the full URL a webhook recipe accepts POSTs at. The bridge
 * exposes webhooks under /hooks/<path>. We always default to localhost —
 * for remote bridges users adjust the host themselves; the strategic plan
 * §4 emphasizes "anything that can send HTTP," not deployment topology. */
function buildWebhookUrl(port: number | undefined, path: string): string {
  const p = port ?? 3101;
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `http://localhost:${p}/hooks${cleanPath}`;
}

function buildCurlExample(port: number | undefined, path: string): string {
  const url = buildWebhookUrl(port, path);
  return `curl -X POST ${url} \\\n  -H 'Content-Type: application/json' \\\n  -d '{"hello":"world"}'`;
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn sm ghost"
      style={{ fontSize: 11, padding: "2px 8px" }}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // clipboard API blocked (insecure origin etc.) — silently no-op
        }
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

// Tool prefix → connector name mapping
const TOOL_PREFIX_MAP: Record<string, string> = {
  slack_: "slack",
  github_: "github",
  jira_: "jira",
  linear_: "linear",
  gmail_: "gmail",
  calendar_: "googleCalendar",
  intercom_: "intercom",
  hubspot_: "hubspot",
  datadog_: "datadog",
  stripe_: "stripe",
  sentry_: "sentry",
};

function detectConnectors(recipes: Recipe[]): string[] {
  const found = new Set<string>();
  for (const recipe of recipes) {
    // Inspect steps via the raw recipe fields we have. The bridge returns
    // stepCount but not step details, so we scan the name/description for
    // tool mentions as a best-effort heuristic. Full step data would require
    // a separate fetch per recipe; for now we match any known prefix in name
    // + description text to avoid an N+1 request pattern.
    const haystack = `${recipe.name} ${recipe.description ?? ""}`.toLowerCase();
    for (const [prefix, connector] of Object.entries(TOOL_PREFIX_MAP)) {
      if (haystack.includes(prefix)) {
        found.add(connector);
      }
    }
  }
  return Array.from(found).sort();
}

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const d = new Date(ms);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

interface RecipeVar {
  name: string;
  description?: string;
  required?: boolean;
  default?: string;
}

interface Recipe {
  id?: string;
  name: string;
  version?: string;
  description?: string;
  installedAt?: number;
  source?: string;
  trigger?: string;
  webhookPath?: string;
  stepCount?: number;
  path?: string;
  enabled?: boolean;
  vars?: RecipeVar[];
  lastRun?: number;
  lint?: {
    ok: boolean;
    errorCount: number;
    warningCount: number;
    firstError?: string;
  };
}

interface RunRecord {
  recipe: string;
  recipeName?: string;
  startedAt: number;
  status: string;
}

interface RunModalState {
  recipe: Recipe;
}

function RunModal({
  state,
  onClose,
  onConfirm,
  running,
}: {
  state: RunModalState;
  onClose: () => void;
  onConfirm: (vars: Record<string, string>) => void;
  running: boolean;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const v of state.recipe.vars ?? []) {
      init[v.name] = v.default ?? "";
    }
    return init;
  });

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) onClose();
  }

  const vars = state.recipe.vars ?? [];

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--border-default)",
          borderRadius: "var(--r-3)",
          padding: "var(--s-6)",
          minWidth: 360,
          maxWidth: 480,
          width: "100%",
          boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "var(--s-4)",
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: 16,
              fontWeight: 600,
              color: "var(--fg-0)",
            }}
          >
            Run{" "}
            <code
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 14,
                background: "var(--bg-2)",
                padding: "1px 6px",
                borderRadius: "var(--r-1)",
              }}
            >
              {state.recipe.name}
            </code>
          </h2>
          <button
            type="button"
            className="btn sm ghost"
            onClick={onClose}
            aria-label="Close"
            style={{ padding: "0 var(--s-2)", fontSize: 16 }}
          >
            &#x2715;
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            onConfirm(values);
          }}
        >
          <div
            style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}
          >
            {vars.map((v) => (
              <div key={v.name}>
                <label
                  htmlFor={`run-var-${v.name}`}
                  style={{
                    display: "block",
                    marginBottom: "var(--s-1)",
                    fontSize: 13,
                    fontWeight: 500,
                    color: "var(--fg-1)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {v.name}
                  {v.required && (
                    <span style={{ color: "var(--err)", marginLeft: 4 }}>*</span>
                  )}
                </label>
                {v.description && (
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--fg-3)",
                      marginBottom: "var(--s-1)",
                    }}
                  >
                    {v.description}
                  </div>
                )}
                <input
                  id={`run-var-${v.name}`}
                  type="text"
                  required={v.required}
                  value={values[v.name] ?? ""}
                  placeholder={v.description ?? v.default ?? ""}
                  onChange={(e) => {
                    const val = e.target.value;
                    setValues((prev) => ({ ...prev, [v.name]: val }));
                  }}
                  style={{
                    width: "100%",
                    background: "var(--bg-2)",
                    border: "1px solid var(--border-default)",
                    borderRadius: "var(--r-2)",
                    color: "var(--fg-0)",
                    fontSize: 13,
                    padding: "var(--s-2) var(--s-3)",
                    outline: "none",
                    fontFamily: "var(--font-mono)",
                  }}
                />
              </div>
            ))}
          </div>

          <div
            style={{
              display: "flex",
              gap: "var(--s-3)",
              marginTop: "var(--s-5)",
              justifyContent: "flex-end",
            }}
          >
            <button
              type="button"
              className="btn ghost"
              onClick={onClose}
              disabled={running}
            >
              Cancel
            </button>
            <button type="submit" className="btn" disabled={running}>
              {running ? "Starting…" : "Run recipe"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function RecipesPage() {
  const { data: bridgeStatus } = useBridgeFetch<BridgeStatusForRecipes>(
    "/api/bridge/status",
    { intervalMs: 10000 },
  );
  const bridgePort = bridgeStatus?.patchwork?.port ?? bridgeStatus?.port;
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [runMap, setRunMap] = useState<Map<string, RunRecord>>(new Map());
  const [err, setErr] = useState<string>();
  const [unsupported, setUnsupported] = useState(false);
  const [running, setRunning] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<RunModalState | null>(null);
  const [modalRunning, setModalRunning] = useState(false);
  const [search, setSearch] = useState("");

  const load = React.useCallback(async () => {
    try {
      const [recipesRes, runsRes] = await Promise.all([
        fetch(apiPath("/api/bridge/recipes")),
        fetch(apiPath("/api/bridge/runs")).catch(() => null),
      ]);
      if (recipesRes.status === 404) {
        setUnsupported(true);
        setRecipes([]);
        return;
      }
      if (!recipesRes.ok) throw new Error(`/recipes ${recipesRes.status}`);
      const data = await recipesRes.json();
      const list: Recipe[] = Array.isArray(data)
        ? data
        : Array.isArray(data?.recipes)
          ? data.recipes
          : [];
      setRecipes(list);

      if (runsRes?.ok) {
        const runsData = (await runsRes.json()) as { runs?: RunRecord[] };
        const runs = runsData.runs ?? [];
        const map = new Map<string, RunRecord>();
        for (const run of runs) {
          // recipeName may have ":agent" suffix from orchestrator — strip it for matching
          const key = (run.recipeName ?? run.recipe ?? "").replace(/:agent$/, "");
          const existing = map.get(key);
          if (!existing || run.startedAt > existing.startedAt) {
            map.set(key, run);
          }
        }
        setRunMap(map);
        // Clear "queued …" / "running…" badges for recipes whose latest run has settled
        setRunning((prev) => {
          const next = { ...prev };
          let changed = false;
          for (const name of Object.keys(next)) {
            const latest = map.get(name);
            if (latest && latest.status !== "running") {
              delete next[name];
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, [load]);

  async function executeRun(name: string, vars?: Record<string, string>) {
    setRunning((p) => ({ ...p, [name]: "running…" }));
    try {
      const body: Record<string, unknown> = {};
      if (vars && Object.keys(vars).length > 0) body.vars = vars;
      const res = await fetch(
        apiPath(`/api/bridge/recipes/${encodeURIComponent(name)}/run`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data = (await res.json()) as {
        ok: boolean;
        taskId?: string;
        error?: string;
      };
      if (data.ok && data.taskId) {
        setRunning((p) => ({
          ...p,
          [name]: `queued ${data.taskId?.slice(0, 8)}`,
        }));
      } else {
        const errMsg =
          data.error === "already_in_flight"
            ? "Already running"
            : `error: ${data.error ?? "unknown"}`;
        setRunning((p) => ({ ...p, [name]: errMsg }));
      }
    } catch (e) {
      setRunning((p) => ({
        ...p,
        [name]: `error: ${e instanceof Error ? e.message : String(e)}`,
      }));
    }
  }

  function handleRunClick(recipe: Recipe) {
    const vars = recipe.vars ?? [];
    if (vars.length === 0) {
      void executeRun(recipe.name);
      return;
    }
    setModal({ recipe });
    setModalRunning(false);
  }

  async function handleDelete(name: string) {
    if (
      typeof window !== "undefined" &&
      !window.confirm(`Delete recipe "${name}"? This removes the file from disk.`)
    ) {
      return;
    }
    try {
      const res = await fetch(
        apiPath(`/api/bridge/recipes/${encodeURIComponent(name)}`),
        { method: "DELETE" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setErr(body.error ?? `delete failed: ${res.status}`);
        return;
      }
      void load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleSendTestWebhook(recipe: Recipe) {
    const path = recipe.webhookPath;
    if (!path) return;
    setRunning((p) => ({ ...p, [recipe.name]: "sending test…" }));
    try {
      const res = await fetch(apiPath(`/api/bridge/hooks${path}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test: true, sentAt: new Date().toISOString() }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        taskId?: string;
      };
      if (res.ok && body.ok !== false) {
        setRunning((p) => ({
          ...p,
          [recipe.name]: body.taskId
            ? `test queued ${body.taskId.slice(0, 8)}`
            : "test sent",
        }));
      } else {
        setRunning((p) => ({
          ...p,
          [recipe.name]: `test error: ${body.error ?? res.status}`,
        }));
      }
    } catch (e) {
      setRunning((p) => ({
        ...p,
        [recipe.name]: `test error: ${e instanceof Error ? e.message : String(e)}`,
      }));
    }
  }

  async function handleModalConfirm(vars: Record<string, string>) {
    if (!modal) return;
    const name = modal.recipe.name;
    setModalRunning(true);
    try {
      await executeRun(name, vars);
    } finally {
      setModal(null);
      setModalRunning(false);
    }
  }

  const filteredRecipes = (recipes ?? []).filter((r) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return r.name.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q);
  });

  function recipeStatus(r: Recipe): "idle" | "running" | "failed" {
    const run = runMap.get(r.name);
    if (!run) return "idle";
    if (run.status === "running") return "running";
    if (run.status === "error" || run.status === "failed") return "failed";
    return "idle";
  }

  return (
    <section>
      {modal && (
        <RunModal
          state={modal}
          onClose={() => setModal(null)}
          onConfirm={handleModalConfirm}
          running={modalRunning}
        />
      )}

      <div className="page-head">
        <div>
          <h1>Recipes</h1>
          <div className="page-head-sub">
            Your automation recipes and their run status.
          </div>
        </div>
        <div
          style={{ display: "flex", alignItems: "center", gap: "var(--s-2)" }}
        >
          {recipes && (
            <span className="pill muted">{filteredRecipes.length} installed</span>
          )}
          <Link href="/marketplace" className="btn sm ghost" style={{ textDecoration: "none" }}>
            Browse marketplace →
          </Link>
          <Link href="/recipes/new" className="btn primary" style={{ textDecoration: "none" }}>
            New recipe
          </Link>
        </div>
      </div>

      <div style={{ marginBottom: "var(--s-4)" }}>
        <input
          type="search"
          className="input"
          placeholder="Search recipes…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: 320 }}
        />
      </div>

      {err && <div className="alert-err">Unreachable: {err}</div>}

      {recipes === null && !err ? (
        <div className="empty-state">
          <p>Loading…</p>
        </div>
      ) : recipes === null || recipes.length === 0 ? (
        <div className="empty-state">
          <h3>No recipes installed</h3>
          <p>Browse the marketplace or author your own.</p>
          <div style={{ display: "flex", gap: "var(--s-2)", marginTop: "var(--s-3)" }}>
            <Link href="/marketplace" className="btn primary" style={{ textDecoration: "none" }}>
              Browse marketplace
            </Link>
            <Link href="/recipes/new" className="btn ghost" style={{ textDecoration: "none" }}>
              New recipe
            </Link>
          </div>
          {unsupported && (
            <p style={{ marginTop: 12, fontSize: 12 }}>
              Recipe listing endpoint not available on this bridge version.
            </p>
          )}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th style={{ width: 100 }}>Trigger</th>
                <th style={{ width: 70 }}>Steps</th>
                <th>Description</th>
                <th style={{ width: 100 }}>Last Run</th>
                <th style={{ width: 90 }}>Status</th>
                <th style={{ width: 220 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredRecipes.map((r, i) => {
                const state = running[r.name];
                const lastRun = runMap.get(r.name);
                const status = recipeStatus(r);
                return (
                  <React.Fragment key={r.path ?? r.id ?? `${r.name}:${i}`}>
                    <tr>
                      <td className="mono">
                        <button
                          type="button"
                          style={{
                            background: "none",
                            border: "none",
                            padding: 0,
                            cursor: "pointer",
                            fontFamily: "inherit",
                            fontSize: "inherit",
                            color: "inherit",
                            userSelect: "none",
                            textAlign: "left",
                          }}
                          onClick={() =>
                            setExpanded((prev) => {
                              const next = new Set(prev);
                              next.has(r.name)
                                ? next.delete(r.name)
                                : next.add(r.name);
                              return next;
                            })
                          }
                        >
                          {expanded.has(r.name) ? "▾" : "▸"} {r.name}
                        </button>
                      </td>
                      <td>
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <span className="pill muted">{r.trigger ?? "—"}</span>
                          {r.lint && !r.lint.ok && (
                            <span
                              className="pill err"
                              style={{ fontSize: 10 }}
                              title={r.lint.firstError ?? "Recipe has lint errors"}
                            >
                              ✗ {r.lint.errorCount} error{r.lint.errorCount === 1 ? "" : "s"}
                            </span>
                          )}
                          {r.lint?.ok && r.lint.warningCount > 0 && (
                            <span
                              className="pill warn"
                              style={{ fontSize: 10 }}
                              title={`${r.lint.warningCount} lint warning${r.lint.warningCount === 1 ? "" : "s"}`}
                            >
                              ⚠ {r.lint.warningCount}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="mono muted">{r.stepCount ?? "—"}</td>
                      <td
                        style={{
                          // Clamp long descriptions to two lines so a single
                          // verbose recipe (e.g. ctx-loop-test) doesn't push
                          // every other row into a vertical pile. Hover/focus
                          // the row to read the full text via the title attr.
                          maxWidth: 480,
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical" as const,
                          overflow: "hidden",
                        }}
                        title={r.description ?? ""}
                      >
                        {r.description ?? <span className="muted">—</span>}
                      </td>
                      <td className="muted" style={{ fontSize: 12 }}>
                        {lastRun ? relTime(lastRun.startedAt) : "—"}
                      </td>
                      <td>
                        {r.enabled === false ? (
                          <span className="pill muted">Disabled</span>
                        ) : status === "running" ? (
                          <span className="pill warn">Running</span>
                        ) : status === "failed" ? (
                          <span className="pill err">Failed</span>
                        ) : (
                          <span className="pill muted">Idle</span>
                        )}
                      </td>
                      <td>
                        <div
                          style={{
                            display: "flex",
                            gap: 8,
                            alignItems: "center",
                          }}
                        >
                          <button
                            type="button"
                            className="btn"
                            onClick={() => handleRunClick(r)}
                            disabled={r.enabled === false}
                          >
                            Run{r.vars && r.vars.length > 0 ? "…" : ""}
                          </button>
                          <button
                            type="button"
                            className="btn sm ghost"
                            style={{
                              fontSize: 11,
                              padding: "2px 8px",
                            }}
                            title={r.enabled === false ? "Enable recipe" : "Disable recipe"}
                            onClick={async () => {
                              await fetch(
                                apiPath(`/api/bridge/recipes/${encodeURIComponent(r.name)}`),
                                {
                                  method: "PATCH",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ enabled: r.enabled === false }),
                                },
                              );
                              void load();
                            }}
                          >
                            {r.enabled === false ? "Enable" : "Disable"}
                          </button>
                          {r.webhookPath && (
                            <button
                              type="button"
                              className="btn sm ghost"
                              style={{ fontSize: 11, padding: "2px 8px" }}
                              title={`Send test POST to ${r.webhookPath}`}
                              onClick={() => void handleSendTestWebhook(r)}
                            >
                              Test
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn sm ghost"
                            style={{ fontSize: 11, padding: "2px 8px", color: "var(--err)" }}
                            title="Delete recipe file"
                            onClick={() => void handleDelete(r.name)}
                          >
                            Delete
                          </button>
                          {state && (
                            <span
                              className="pill muted"
                              style={{ fontSize: 11 }}
                            >
                              {state}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                    {expanded.has(r.name) && (
                      <tr key={`${r.path ?? r.id ?? `${r.name}:${i}`}-detail`}>
                        <td
                          colSpan={7}
                          style={{
                            padding: "8px 16px 16px",
                            background: "var(--bg-2)",
                          }}
                        >
                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns:
                                "repeat(auto-fill, minmax(240px, 1fr))",
                              gap: "8px 24px",
                              fontSize: 12,
                            }}
                          >
                            <div>
                              <span className="muted">Path</span>
                              <br />
                              <code>{r.path ?? "—"}</code>
                            </div>
                            <div>
                              <span className="muted">Installed</span>
                              <br />
                              {r.installedAt !== undefined
                                ? relTime(r.installedAt)
                                : "—"}
                            </div>
                            <div>
                              <span className="muted">Source</span>
                              <br />
                              <span className="pill muted">
                                {r.source ?? "—"}
                              </span>
                            </div>
                            <div style={{ gridColumn: "1 / -1" }}>
                              <span className="muted" style={{ fontSize: 11 }}>
                                Patchwork does not enforce per-recipe
                                permissions; configure tool gating in
                                {" "}
                                <code>~/.claude/settings.json</code>.
                                {/* TODO(C-PR4): drop never-shipped POST /recipes/:name/permissions
                                    route (DP-7 follow-up from PLAN-MASTER-V2 A-PR4). */}
                              </span>
                            </div>
                            {r.webhookPath && (
                              <div style={{ gridColumn: "1 / -1" }}>
                                <span className="muted">Webhook URL</span>
                                <div
                                  style={{
                                    display: "flex",
                                    gap: 8,
                                    alignItems: "center",
                                    marginTop: 4,
                                  }}
                                >
                                  <code
                                    style={{
                                      fontSize: 12,
                                      flex: 1,
                                      overflowX: "auto",
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    {buildWebhookUrl(bridgePort, r.webhookPath)}
                                  </code>
                                  <CopyButton
                                    text={buildWebhookUrl(bridgePort, r.webhookPath)}
                                    label="Copy URL"
                                  />
                                </div>
                                <div
                                  style={{
                                    marginTop: 8,
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "flex-start",
                                    gap: 8,
                                  }}
                                >
                                  <span className="muted">Example request</span>
                                  <CopyButton
                                    text={buildCurlExample(bridgePort, r.webhookPath)}
                                    label="Copy curl"
                                  />
                                </div>
                                <pre
                                  style={{
                                    fontSize: 11,
                                    background: "var(--bg-1)",
                                    border: "1px solid var(--border-subtle)",
                                    borderRadius: "var(--r-2)",
                                    padding: "8px 10px",
                                    margin: "4px 0 0",
                                    overflowX: "auto",
                                    whiteSpace: "pre",
                                  }}
                                >
                                  {buildCurlExample(bridgePort, r.webhookPath)}
                                </pre>
                                <p
                                  style={{
                                    marginTop: 6,
                                    fontSize: 11,
                                    color: "var(--fg-2)",
                                    lineHeight: 1.4,
                                  }}
                                >
                                  Anything that can send HTTP can trigger this:
                                  iPhone Shortcut, Stream Deck, Home Assistant,
                                  NFC tag, cron job, or another service.
                                </p>
                              </div>
                            )}
                            {r.lint && (r.lint.errorCount > 0 || r.lint.warningCount > 0) && (
                              <div style={{ gridColumn: "1 / -1" }}>
                                <span className="muted">Lint</span>
                                <br />
                                {r.lint.firstError && (
                                  <span style={{ color: "var(--err)", fontSize: 12 }}>
                                    {r.lint.firstError}
                                  </span>
                                )}
                                {!r.lint.firstError && r.lint.warningCount > 0 && (
                                  <span style={{ color: "var(--warn, var(--ink-2))", fontSize: 12 }}>
                                    {r.lint.warningCount} warning{r.lint.warningCount === 1 ? "" : "s"} — open the editor for details
                                  </span>
                                )}
                              </div>
                            )}
                            {r.vars && r.vars.length > 0 && (
                              <div style={{ gridColumn: "1 / -1" }}>
                                <span className="muted">Variables</span>
                                <br />
                                <div
                                  style={{
                                    display: "flex",
                                    flexWrap: "wrap",
                                    gap: "4px 8px",
                                    marginTop: 4,
                                  }}
                                >
                                  {r.vars.map((v) => (
                                    <span
                                      key={v.name}
                                      className="pill muted"
                                      style={{ fontFamily: "var(--font-mono)" }}
                                      title={v.description}
                                    >
                                      {v.name}
                                      {v.required ? (
                                        <span style={{ color: "var(--err)" }}>
                                          *
                                        </span>
                                      ) : null}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {recipes && recipes.length > 0 && (
        <ConnectorHealthPanel connectors={detectConnectors(recipes)} />
      )}
    </section>
  );
}
