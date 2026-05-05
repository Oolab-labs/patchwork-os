"use client";
import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiPath } from "@/lib/api";
import { ConnectorHealthPanel } from "@/components/ConnectorHealthPanel";
import { SkeletonList } from "@/components/Skeleton";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";
import {
  CodeBlock,
  ErrorState,
  LivePill,
  PatchCard,
  RunSparkBars,
  StatusPill,
} from "@/components/patchwork";

interface BridgeStatusForRecipes {
  patchwork?: { port?: number };
  port?: number;
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
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  const d = new Date(ms);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatDuration(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

interface RecipeVar {
  name: string;
  description?: string;
  required?: boolean;
  default?: string;
}

type TrustLevel =
  | "draft"
  | "manual_run"
  | "ask_every_time"
  | "ask_novel"
  | "mostly_trusted"
  | "fully_trusted";

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
  trustLevel?: TrustLevel;
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
  durationMs?: number;
  toolCount?: number;
  taskId?: string;
}

interface RunModalState {
  recipe: Recipe;
}

interface RecipeContentResponse {
  name?: string;
  content?: string;
  yaml?: string;
  raw?: string;
  text?: string;
  steps?: unknown[];
  [k: string]: unknown;
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
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            Run <code>{state.recipe.name}</code>
          </h2>
          <button
            type="button"
            className="btn sm ghost"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onConfirm(values);
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
            {vars.map((v) => (
              <div key={v.name}>
                <label
                  htmlFor={`run-var-${v.name}`}
                  style={{ display: "block", marginBottom: 4, fontSize: 13, fontFamily: "var(--font-mono)" }}
                >
                  {v.name}
                  {v.required && <span style={{ color: "var(--err)", marginLeft: 4 }}>*</span>}
                </label>
                {v.description && (
                  <div style={{ fontSize: 12, color: "var(--fg-3)", marginBottom: 4 }}>
                    {v.description}
                  </div>
                )}
                <input
                  id={`run-var-${v.name}`}
                  type="text"
                  required={v.required}
                  value={values[v.name] ?? ""}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [v.name]: e.target.value }))
                  }
                  className="input"
                  style={{ width: "100%" }}
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
            <button type="button" className="btn ghost" onClick={onClose} disabled={running}>
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

/** Small donut ring showing success rate (0-100). */
function SuccessRing({
  pct,
  size = 28,
  stroke = 4,
}: {
  pct: number | null;
  size?: number;
  stroke?: number;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const safePct = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const dash = (safePct / 100) * c;
  const color =
    pct == null
      ? "var(--line-3)"
      : safePct >= 90
        ? "var(--ok, #22c55e)"
        : safePct >= 60
          ? "var(--warn, #e6a817)"
          : "var(--err, #ef4444)";
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ display: "block", flexShrink: 0 }}
      aria-label={pct == null ? "no run data" : `${Math.round(safePct)}% success`}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--line-3)"
        strokeWidth={stroke}
      />
      {pct != null && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeDasharray={`${dash} ${c - dash}`}
          strokeDashoffset={c / 4}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="central"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: size <= 28 ? 8 : 10,
          fontWeight: 700,
          fill: "var(--ink-1)",
        }}
      >
        {pct == null ? "—" : `${Math.round(safePct)}`}
      </text>
    </svg>
  );
}

/** Lightweight YAML coloriser — keys, values, comments. */
function highlightYaml(yaml: string): React.ReactNode {
  const lines = yaml.split("\n");
  return lines.map((line, i) => {
    const commentIdx = line.indexOf("#");
    let codePart = line;
    let comment = "";
    if (commentIdx >= 0) {
      // Naively avoid splitting inside quoted strings; good enough for recipes.
      const before = line.slice(0, commentIdx);
      const quoteOpen = (before.match(/"/g) ?? []).length % 2 === 1;
      if (!quoteOpen) {
        codePart = before;
        comment = line.slice(commentIdx);
      }
    }
    const m = codePart.match(/^(\s*-?\s*)([A-Za-z0-9_./-]+)(\s*:)(\s*)(.*)$/);
    let body: React.ReactNode = codePart;
    if (m) {
      const [, lead, key, colon, ws, rest] = m;
      body = (
        <>
          <span>{lead}</span>
          <span className="yaml-key" style={{ color: "var(--accent, #7aa2f7)" }}>{key}</span>
          <span>{colon}</span>
          <span>{ws}</span>
          {rest && (
            <span className="yaml-string" style={{ color: "var(--ok, #9ece6a)" }}>{rest}</span>
          )}
        </>
      );
    }
    return (
      <div key={i}>
        {body}
        {comment && (
          <span className="yaml-comment" style={{ color: "var(--ink-3)", fontStyle: "italic" }}>
            {comment}
          </span>
        )}
        {!line && " "}
      </div>
    );
  });
}

/** Build a presentable YAML string from recipe metadata when raw isn't available. */
function fallbackYaml(recipe: Recipe): string {
  const lines: string[] = [];
  lines.push(`name: ${recipe.name}`);
  if (recipe.version) lines.push(`version: ${recipe.version}`);
  if (recipe.description) lines.push(`description: ${recipe.description}`);
  lines.push(`trigger: ${recipe.trigger ?? "manual"}`);
  if (recipe.webhookPath) lines.push(`webhookPath: ${recipe.webhookPath}`);
  if (recipe.stepCount != null) lines.push(`# ${recipe.stepCount} step(s)`);
  if (recipe.path) lines.push(`# path: ${recipe.path}`);
  if (recipe.vars && recipe.vars.length > 0) {
    lines.push("vars:");
    for (const v of recipe.vars) {
      lines.push(`  - name: ${v.name}`);
      if (v.required) lines.push(`    required: true`);
      if (v.default !== undefined) lines.push(`    default: ${v.default}`);
      if (v.description) lines.push(`    description: ${v.description}`);
    }
  }
  return lines.join("\n");
}

function RecipeYamlPanel({ recipe }: { recipe: Recipe }) {
  const [yaml, setYaml] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setYaml(null);
    (async () => {
      try {
        const res = await fetch(
          apiPath(`/api/bridge/recipes/${encodeURIComponent(recipe.name)}`),
        );
        if (!res.ok) throw new Error(`fetch ${res.status}`);
        const data = (await res.json()) as RecipeContentResponse;
        if (cancelled) return;
        const raw =
          (typeof data.content === "string" && data.content) ||
          (typeof data.yaml === "string" && data.yaml) ||
          (typeof data.raw === "string" && data.raw) ||
          (typeof data.text === "string" && data.text) ||
          "";
        setYaml(raw || fallbackYaml(recipe));
      } catch {
        if (!cancelled) setYaml(fallbackYaml(recipe));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [recipe]);

  return (
    <CodeBlock
      style={{
        background: "var(--recess)",
        border: "1px solid var(--line-2)",
        borderRadius: "var(--r-2)",
        padding: "10px 12px",
        fontSize: 11,
        lineHeight: 1.55,
        maxHeight: 360,
        overflow: "auto",
        fontFamily: "var(--font-mono)",
      }}
    >
      {loading && !yaml ? "Loading…" : highlightYaml(yaml ?? fallbackYaml(recipe))}
    </CodeBlock>
  );
}

function RecipeDetailPanel({
  recipe,
  recentRuns,
  onClose,
  onRun,
  running,
  isLive,
}: {
  recipe: Recipe;
  recentRuns: RunRecord[];
  onClose: () => void;
  onRun: () => void;
  running: Record<string, string>;
  isLive: boolean;
}) {
  return (
    <PatchCard
      className="recipes-detail-panel"
      style={{
        position: "sticky",
        top: 80,
        overflowY: "auto",
        maxHeight: "calc(100vh - 100px)",
        padding: "var(--s-4)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontWeight: 700,
            fontSize: 13,
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={recipe.name}
        >
          {recipe.name}
        </span>
        {isLive && <LivePill tone="ok" />}
        <button type="button" onClick={onRun} className="btn sm primary" style={{ fontSize: 11 }}>
          ▶ Run
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close detail panel"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--ink-3)",
            fontSize: 18,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>

      {running[recipe.name] && (
        <div style={{ marginBottom: 10 }}>
          <StatusPill tone="warn">{running[recipe.name]}</StatusPill>
        </div>
      )}

      <div style={{ marginBottom: 14 }}>
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--ink-3)",
            marginBottom: 6,
          }}
        >
          Recipe YAML
        </div>
        <RecipeYamlPanel recipe={recipe} />
      </div>

      <div>
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--ink-3)",
            marginBottom: 6,
          }}
        >
          Recent runs
        </div>
        {recentRuns.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>No runs yet.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {recentRuns.map((run, i) => {
              const ok = run.status === "done" || run.status === "success";
              const fail = run.status === "error" || run.status === "failed";
              const tone = ok ? "ok" : fail ? "err" : "warn";
              return (
                <div
                  key={`${run.startedAt}-${i}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  <StatusPill tone={tone}>{ok ? "ok" : run.status}</StatusPill>
                  <span style={{ color: "var(--ink-3)", flex: 1 }}>{relTime(run.startedAt)}</span>
                  <span style={{ color: "var(--ink-2)" }}>{formatDuration(run.durationMs)}</span>
                  {typeof run.toolCount === "number" && (
                    <span style={{ color: "var(--ink-3)" }}>{run.toolCount} tools</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </PatchCard>
  );
}

export default function RecipesPage() {
  const { data: bridgeStatus } = useBridgeFetch<BridgeStatusForRecipes>(
    "/api/bridge/status",
    { intervalMs: 10000 },
  );
  // bridgePort retained for parity with prior page (used by webhook helpers in callers).
  void bridgeStatus;
  const router = useRouter();
  void router;
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [runMap, setRunMap] = useState<Map<string, RunRecord>>(new Map());
  const [recentRunsMap, setRecentRunsMap] = useState<Map<string, RunRecord[]>>(new Map());
  const [allRunsMap, setAllRunsMap] = useState<Map<string, RunRecord[]>>(new Map());
  const [err, setErr] = useState<string>();
  const [unsupported, setUnsupported] = useState(false);
  const [running, setRunning] = useState<Record<string, string>>({});
  const [selectedName, setSelectedName] = useState<string | null>(null);
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
        const latest = new Map<string, RunRecord>();
        const recent = new Map<string, RunRecord[]>();
        const all = new Map<string, RunRecord[]>();
        for (const run of runs) {
          const key = (run.recipeName ?? run.recipe ?? "").replace(/:agent$/, "");
          const existing = latest.get(key);
          if (!existing || run.startedAt > existing.startedAt) {
            latest.set(key, run);
          }
          const r = recent.get(key) ?? [];
          r.push(run);
          recent.set(key, r);
          const a = all.get(key) ?? [];
          a.push(run);
          all.set(key, a);
        }
        for (const [k, l] of recent) {
          recent.set(k, l.sort((a, b) => b.startedAt - a.startedAt).slice(0, 5));
        }
        for (const [k, l] of all) {
          all.set(k, l.sort((a, b) => b.startedAt - a.startedAt).slice(0, 14));
        }
        setRunMap(latest);
        setRecentRunsMap(recent);
        setAllRunsMap(all);
        setRunning((prev) => {
          const next = { ...prev };
          let changed = false;
          for (const name of Object.keys(next)) {
            const l = latest.get(name);
            if (l && l.status !== "running") {
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
      const data = (await res.json()) as { ok: boolean; taskId?: string; error?: string };
      if (data.ok && data.taskId) {
        setRunning((p) => ({ ...p, [name]: `queued ${data.taskId?.slice(0, 8)}` }));
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

  async function handleToggleEnabled(recipe: Recipe) {
    try {
      await fetch(apiPath(`/api/bridge/recipes/${encodeURIComponent(recipe.name)}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: recipe.enabled === false }),
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    void load();
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
    return (
      r.name.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q)
    );
  });

  const enabledCount = (recipes ?? []).filter((r) => r.enabled !== false).length;
  const installedCount = recipes?.length ?? 0;

  const selectedRecipe = useMemo(
    () => filteredRecipes.find((r) => r.name === selectedName) ?? null,
    [filteredRecipes, selectedName],
  );

  function successPct(name: string): number | null {
    const runs = allRunsMap.get(name);
    if (!runs || runs.length === 0) return null;
    const settled = runs.filter(
      (r) => r.status !== "running" && r.status !== "queued" && r.status !== "pending",
    );
    if (settled.length === 0) return null;
    const ok = settled.filter((r) => r.status === "done" || r.status === "success").length;
    return (ok / settled.length) * 100;
  }

  function avgDuration(name: string): number | undefined {
    const runs = allRunsMap.get(name);
    if (!runs || runs.length === 0) return undefined;
    const ds = runs
      .map((r) => r.durationMs)
      .filter((d): d is number => typeof d === "number" && d > 0);
    if (ds.length === 0) return undefined;
    return ds.reduce((s, d) => s + d, 0) / ds.length;
  }

  function isLive(name: string): boolean {
    const latest = runMap.get(name);
    return latest?.status === "running";
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
          <h1 className="editorial-h1">
            Recipes — <span className="accent">YAML, declarative, yours.</span>
          </h1>
          <div className="editorial-sub">
            {recipes
              ? `templates/recipes · ${installedCount} installed · ${enabledCount} enabled`
              : "Loading…"}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s-2)" }}>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => void load()}
            title="Reload recipes"
          >
            ↻ Reload
          </button>
          <Link
            href="/recipes/new"
            className="btn primary"
            style={{ textDecoration: "none" }}
          >
            + Add recipe
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

      {err && (recipes === null || recipes.length === 0) && (
        <ErrorState
          title="Couldn't load recipes"
          description="The bridge isn't responding to /recipes. Check that the bridge is running."
          error={err}
          onRetry={() => window.location.reload()}
        />
      )}
      {err && recipes && recipes.length > 0 && (
        <div className="alert-err">Refresh failed — {err}</div>
      )}

      {recipes === null && !err ? (
        <SkeletonList rows={4} columns={3} />
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
        <div
          className={`recipes-grid${selectedRecipe ? " has-detail" : ""}`}
          style={{
            display: "grid",
            gap: "var(--s-4)",
            alignItems: "start",
            transition: "grid-template-columns 0.18s ease",
            minWidth: 0,
          }}
        >
          <PatchCard padded={false} style={{ overflow: "hidden", minWidth: 0 }}>
            <div className="table-wrap" style={{ minWidth: 0, overflow: "auto" }}>
              <table className="table" style={{ width: "100%", tableLayout: "fixed" }}>
                <thead>
                  <tr>
                    <th style={{ width: 48, textAlign: "center" }}>%</th>
                    <th style={{ minWidth: 160 }}>RECIPE</th>
                    <th style={{ width: 120 }}>TRIGGER</th>
                    <th style={{ width: 90, textAlign: "center" }}>LAST 14 RUNS</th>
                    <th style={{ width: 80 }}>AVG</th>
                    <th style={{ width: 100 }}>LAST</th>
                    <th style={{ width: 110, textAlign: "right" }}>&nbsp;</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRecipes.map((r, i) => {
                    const live = isLive(r.name);
                    const last = runMap.get(r.name);
                    const sel = selectedName === r.name;
                    const pct = successPct(r.name);
                    const avg = avgDuration(r.name);
                    const enabled = r.enabled !== false;
                    return (
                      <tr
                        key={r.path ?? r.id ?? `${r.name}:${i}`}
                        onClick={() =>
                          setSelectedName((prev) => (prev === r.name ? null : r.name))
                        }
                        style={{
                          cursor: "pointer",
                          background: sel ? "var(--bg-2)" : undefined,
                        }}
                      >
                        <td style={{ textAlign: "center" }}>
                          <SuccessRing pct={pct} />
                        </td>
                        <td className="mono" style={{ overflow: "hidden" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span
                              style={{
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                fontWeight: sel ? 700 : 500,
                              }}
                              title={r.description ?? r.name}
                            >
                              {r.name}
                            </span>
                            {live && <LivePill tone="ok" />}
                            {!enabled && <StatusPill tone="muted">off</StatusPill>}
                          </div>
                          {r.description && (
                            <div
                              className="muted"
                              style={{
                                fontSize: 11,
                                marginTop: 2,
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                              }}
                            >
                              {r.description}
                            </div>
                          )}
                        </td>
                        <td>
                          <StatusPill tone="muted">{r.trigger ?? "manual"}</StatusPill>
                        </td>
                        <td style={{ textAlign: "center" }}>
                          <RunSparkBars
                            runs={(allRunsMap.get(r.name) ?? []).slice(0, 14)}
                            width={90}
                            height={20}
                          />
                        </td>
                        <td className="mono muted" style={{ fontSize: 12 }}>
                          {formatDuration(avg)}
                        </td>
                        <td className="muted" style={{ fontSize: 12 }}>
                          {last ? relTime(last.startedAt) : "—"}
                        </td>
                        <td
                          style={{ textAlign: "right" }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            role="switch"
                            aria-checked={enabled}
                            aria-label={`${enabled ? "Disable" : "Enable"} ${r.name}`}
                            onClick={() => void handleToggleEnabled(r)}
                            style={{
                              position: "relative",
                              width: 36,
                              height: 20,
                              borderRadius: 999,
                              border: "1px solid var(--line-2)",
                              background: enabled ? "var(--ok, #22c55e)" : "var(--bg-2)",
                              cursor: "pointer",
                              padding: 0,
                              transition: "background 0.15s",
                            }}
                          >
                            <span
                              aria-hidden="true"
                              style={{
                                position: "absolute",
                                top: 1,
                                left: enabled ? 17 : 1,
                                width: 16,
                                height: 16,
                                borderRadius: "50%",
                                background: "white",
                                transition: "left 0.15s",
                                boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
                              }}
                            />
                          </button>
                          <button
                            type="button"
                            className="btn sm"
                            style={{ marginLeft: 8, fontSize: 11 }}
                            onClick={() => handleRunClick(r)}
                            disabled={!enabled}
                          >
                            Run{r.vars && r.vars.length > 0 ? "…" : ""}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </PatchCard>

          {selectedRecipe && (
            <RecipeDetailPanel
              recipe={selectedRecipe}
              recentRuns={recentRunsMap.get(selectedRecipe.name) ?? []}
              onClose={() => setSelectedName(null)}
              onRun={() => handleRunClick(selectedRecipe)}
              running={running}
              isLive={isLive(selectedRecipe.name)}
            />
          )}
        </div>
      )}

      {recipes && recipes.length > 0 && (
        <ConnectorHealthPanel connectors={detectConnectors(recipes)} />
      )}
    </section>
  );
}
