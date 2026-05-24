"use client";
import React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "@/components/Dialog";
import { apiPath } from "@/lib/api";
import { canonicalRecipeKey } from "@/lib/entityKey";
import { ConnectorHealthPanel } from "@/components/ConnectorHealthPanel";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { useActiveRuns } from "@/hooks/LiveRunsContext";
import type { ActiveRunState } from "@/hooks/useRecipeRunStream";
import { RecipeRunInline } from "./_components/RecipeRunInline";
import {
  CodeBlock,
  EmptyState,
  ErrorState,
  HintCard,
  highlightYaml,
  LivePill,
  PatchCard,
  RelationStrip,
  RunSparkBars,
  StatusPill,
  SuccessRing,
} from "@/components/patchwork";
import { RunChip } from "@/components/patchwork/entity";
import { fmtDuration } from "@/components/time";

/**
 * Trigger-type → chip tone. Triggers used to all render in the same
 * "muted" tone, which turned the trigger column into vertical grey
 * wallpaper. Color-coding gives the eye a fast way to scan "cron vs
 * manual vs webhook" without reading the text.
 */
function triggerTone(
  trigger: string | undefined,
): "ok" | "warn" | "info" | "accent" | "muted" | "purple" {
  const t = (trigger ?? "manual").toLowerCase();
  if (t === "cron" || t === "schedule" || t === "scheduled") return "accent";
  if (t === "webhook" || t === "http") return "info";
  if (t === "file_watch" || t === "on_file_save" || t === "fs_watch") return "warn";
  if (t === "channel" || t === "event" || t === "bus") return "purple";
  if (t === "on_test_run" || t === "test_run") return "purple";
  if (t === "git_hook" || t === "git") return "ok";
  return "muted";
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
      // Match either the underscored tool prefix (`slack_chat`) if it
      // happens to be quoted in description text, or the bare connector
      // word (`slack`, `calendar`) which is far more likely to appear in
      // recipe names like "slack-digest" / "calendar-summary".
      const keyword = prefix.replace(/_$/, "");
      if (haystack.includes(prefix) || haystack.includes(keyword)) {
        found.add(connector);
      }
    }
  }
  return Array.from(found).sort();
}

// Keyword → connections-page connector id. Mirrors the heuristic the
// /connections page uses to derive its "N recipes" badge — keeping both
// in sync means the badge count and this filtered list agree. Maps to
// the connections-page `def.id` values (e.g. `google-calendar`), which
// is the id form the `?connector=` deep-link param carries.
const CONNECTOR_KEYWORD_BY_ID: Record<string, string[]> = {
  slack: ["slack"],
  github: ["github"],
  jira: ["jira"],
  linear: ["linear"],
  gmail: ["gmail"],
  "google-calendar": ["calendar", "googlecalendar"],
  intercom: ["intercom"],
  hubspot: ["hubspot"],
  datadog: ["datadog"],
  stripe: ["stripe"],
  sentry: ["sentry"],
  notion: ["notion"],
  discord: ["discord"],
  confluence: ["confluence"],
  pagerduty: ["pagerduty"],
  zendesk: ["zendesk"],
  asana: ["asana"],
  gitlab: ["gitlab"],
};

/**
 * True when a recipe references the given connector id, using the same
 * name/description keyword scan as the /connections page badge. Returns
 * false for unknown connector ids so an unrecognised `?connector=` param
 * yields an empty (rather than full) list.
 */
function recipeMatchesConnector(recipe: Recipe, connectorId: string): boolean {
  const keywords = CONNECTOR_KEYWORD_BY_ID[connectorId];
  if (!keywords) return false;
  const haystack = `${recipe.name} ${recipe.description ?? ""}`.toLowerCase();
  return keywords.some((kw) => haystack.includes(kw));
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
  if (typeof ms !== "number" || ms <= 0) return "—";
  return fmtDuration(ms);
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
  schedule?: string;
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
  /** Bridge run sequence — required for /runs/[seq] deep-link. The bridge
   *  /runs API already returns this; the field was simply missing from
   *  the dashboard-side type. */
  seq?: number;
  startedAt: number;
  status: string;
  durationMs?: number;
  toolCount?: number;
  taskId?: string;
}

interface RunModalState {
  recipe: Recipe;
}

// Per-session confirmation gate for the Run button. The audit critique was that
// confirming on EVERY Run trains users to dismiss the dialog. Confirming once
// per browser session keeps the "you're about to spend money" signal at first
// touch without becoming friction noise on iteration.
const SESSION_RUN_CONFIRMED_KEY = "patchwork:run-confirmed";

function hasConfirmedRunThisSession(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(SESSION_RUN_CONFIRMED_KEY) === "1";
  } catch {
    return false;
  }
}

function markRunConfirmedThisSession(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SESSION_RUN_CONFIRMED_KEY, "1");
  } catch {
    /* sessionStorage may be unavailable (private mode); fail open. */
  }
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
  state: RunModalState | null;
  onClose: () => void;
  onConfirm: (vars: Record<string, string>) => void;
  running: boolean;
}) {
  const [values, setValues] = useState<Record<string, string>>({});

  // Reset form values when the recipe being run changes.
  useEffect(() => {
    if (!state) return;
    const init: Record<string, string> = {};
    for (const v of state.recipe.vars ?? []) {
      init[v.name] = v.default ?? "";
    }
    setValues(init);
  }, [state]);

  const vars = state?.recipe.vars ?? [];

  return (
    <Dialog
      open={state !== null}
      onClose={onClose}
      ariaLabelledBy="run-modal-title"
      maxWidth={480}
    >
      {state && (
        <>
          <div className="run-modal-header">
            <h2 id="run-modal-title" className="run-modal-title">
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
            {vars.length === 0 && (
              <div className="run-modal-confirm-note">
                Running this recipe will execute its steps immediately and may
                use API credits or call external services.
                {state.recipe.trigger && state.recipe.trigger !== "manual" && (
                  <>
                    {" "}
                    Trigger:{" "}
                    <code>
                      {state.recipe.trigger}
                    </code>
                    .
                  </>
                )}
              </div>
            )}
            <div className="run-modal-vars">
              {vars.map((v) => (
                <div key={v.name}>
                  <label htmlFor={`run-var-${v.name}`} className="run-modal-var-label">
                    {v.name}
                    {v.required && <span className="run-modal-required">*</span>}
                  </label>
                  {v.description && (
                    <div className="run-modal-var-desc">{v.description}</div>
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
                  />
                </div>
              ))}
            </div>
            <div className="run-modal-actions">
              <button type="button" className="btn ghost" onClick={onClose} disabled={running}>
                Cancel
              </button>
              <button type="submit" className="btn warn" disabled={running}>
                {running ? "Starting…" : "Run recipe"}
              </button>
            </div>
          </form>
        </>
      )}
    </Dialog>
  );
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
  // Hold the latest recipe in a ref so the fetch effect can build the
  // fallback YAML without re-firing every time the parent poll (5s) hands us
  // a new Recipe object reference for the same recipe.name. Keying the
  // effect on `recipe` directly caused setYaml(null) → "Loading…" → refetch →
  // re-highlight on every poll, producing a visible flicker in the detail
  // panel's <pre class="code-block"> (78 childList mutations / 7s observed).
  const recipeRef = useRef(recipe);
  recipeRef.current = recipe;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setYaml(null);
    (async () => {
      try {
        const res = await fetch(
          apiPath(`/api/bridge/recipes/${encodeURIComponent(recipeRef.current.name)}`),
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
        setYaml(raw || fallbackYaml(recipeRef.current));
      } catch {
        if (!cancelled) setYaml(fallbackYaml(recipeRef.current));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [recipe.name]);

  return (
    <CodeBlock className="recipe-yaml-block">
      {loading && !yaml ? "Loading…" : highlightYaml(yaml ?? fallbackYaml(recipe))}
    </CodeBlock>
  );
}

function RecipeDetailPanel({
  recipe,
  recentRuns,
  onClose,
  onRun,
  onArchive,
  onDelete,
  running,
  isLive,
  activeRun,
}: {
  recipe: Recipe;
  recentRuns: RunRecord[];
  onClose: () => void;
  onRun: () => void;
  onArchive: () => void;
  onDelete: () => void;
  running: Record<string, string>;
  isLive: boolean;
  activeRun: ActiveRunState | undefined;
}) {
  return (
    <PatchCard className="recipes-detail-panel">
      <div className="rdp-header">
        <span className="rdp-title" title={recipe.name}>{recipe.name}</span>
        {isLive && <LivePill tone="ok" />}
        <button type="button" onClick={onRun} className="btn sm primary">▶ Run</button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close detail panel"
          className="rdp-close-btn"
        >
          ×
        </button>
      </div>

      {activeRun ? (
        <div className="rdp-status">
          <RecipeRunInline state={activeRun} density="strip" />
        </div>
      ) : (
        running[recipe.name] && (
          <div className="rdp-status">
            <StatusPill tone="warn">{running[recipe.name]}</StatusPill>
          </div>
        )
      )}

      <div className="rdp-section">
        <div className="rdp-section-label">Recipe YAML</div>
        <RecipeYamlPanel recipe={recipe} />
      </div>

      <div>
        <div className="rdp-section-label">Recent runs</div>
        {recentRuns.length === 0 ? (
          <div className="rdp-no-runs">No runs yet.</div>
        ) : (
          <div className="rdp-runs-list">
            {recentRuns.map((run, i) => {
              const ok = run.status === "done" || run.status === "success";
              const fail = run.status === "error" || run.status === "failed";
              const tone = ok ? "ok" : fail ? "err" : "warn";
              return (
                <div key={`${run.startedAt}-${i}`} className="rdp-run-row">
                  {typeof run.seq === "number" ? (
                    <RunChip
                      seq={run.seq}
                      status={run.status}
                      recipeName={run.recipeName ?? run.recipe}
                      variant="row"
                    />
                  ) : (
                    <StatusPill tone={tone}>{ok ? "ok" : run.status}</StatusPill>
                  )}
                  <span className="rdp-run-time">{relTime(run.startedAt)}</span>
                  <span className="rdp-run-dur">{formatDuration(run.durationMs)}</span>
                  {typeof run.toolCount === "number" && (
                    <span className="rdp-run-tools">{run.toolCount} tools</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="rdp-footer">
        <button
          type="button"
          className="btn sm ghost warn"
          onClick={onArchive}
          title="Move to ~/.patchwork/recipes/.archive — hidden from this list, restorable from disk"
        >
          Archive
        </button>
        <button
          type="button"
          className="btn sm ghost danger"
          onClick={onDelete}
          title="Permanently delete the recipe file. Cannot be undone."
        >
          Delete permanently
        </button>
      </div>
    </PatchCard>
  );
}

/**
 * Sticky run bar shown on mobile (≤ 768px) when a recipe is selected.
 * The inline row Run button is hidden in a horizontally-scrolling 7-column
 * table on phones; this bar gives a guaranteed-visible 44pt-tall primary
 * action without forcing the detail panel into a full-screen sheet.
 *
 * Sits above the MobileBottomNav (z 27 vs nav's 28) so the nav stays on
 * top of taps that miss the bar. CSS class `.recipes-mobile-run-bar` is
 * display:none on desktop via @media.
 */
function MobileRunBar({
  recipe,
  onRun,
  onClose,
  disabled,
}: {
  recipe: Recipe;
  onRun: () => void;
  onClose: () => void;
  disabled: boolean;
}) {
  return (
    <div className="recipes-mobile-run-bar" role="region" aria-label="Selected recipe quick actions">
      <button
        type="button"
        onClick={onClose}
        aria-label="Deselect recipe"
        className="recipes-mobile-run-bar-close"
      >
        ×
      </button>
      <div className="recipes-mobile-run-bar-name" title={recipe.name}>
        {recipe.name}
      </div>
      <button
        type="button"
        className="btn primary"
        onClick={onRun}
        disabled={disabled}
        aria-label={`Run ${recipe.name}`}
      >
        ▶ Run{recipe.vars && recipe.vars.length > 0 ? "…" : ""}
      </button>
    </div>
  );
}

export default function RecipesPage() {
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [runMap, setRunMap] = useState<Map<string, RunRecord>>(new Map());
  const [recentRunsMap, setRecentRunsMap] = useState<Map<string, RunRecord[]>>(new Map());
  const [allRunsMap, setAllRunsMap] = useState<Map<string, RunRecord[]>>(new Map());
  const [err, setErr] = useState<string>();
  const [unsupported, setUnsupported] = useState(false);
  const [running, setRunning] = useState<Record<string, string>>({});
  // ?selected=<name> deep-link (e.g. from suggestions/page.tsx) — redirect
  // immediately to the hub so keyboard and mouse behave identically.
  // We keep the state initialiser below reading the param so the redirect
  // useEffect fires once after mount (when router is available).
  const [selectedName, setSelectedName] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const sp = new URLSearchParams(window.location.search);
    return sp.get("selected");
  });
  const [modal, setModal] = useState<RunModalState | null>(null);
  const [modalRunning, setModalRunning] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "enabled" | "paused">("all");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const toast = useToast();

  // "/" hotkey focuses the search input (GitHub-style). Ignored while
  // typing in another input/textarea/contenteditable so it doesn't
  // hijack normal keystrokes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable) return;
      }
      e.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Live SSE-driven run state, keyed by recipe name. Foundation for inline
  // run observability — see PR #642 (bridge lifecycle emit) + RecipeRunInline.
  const activeRunsByName = useActiveRuns();
  // #600: deep-link support so /recipes?run=<name> auto-opens the
  // RunModal once recipes are loaded. Used by the Inbox Replay
  // button so users land on the recipe with its vars-input modal
  // already open instead of getting a silent 400 for missing vars.
  const searchParams = useSearchParams();
  const router = useRouter();

  // Escape closes the detail panel (when no modal is open — modal owns
  // its own Escape handling via Dialog). Skipped while typing in an
  // input so it doesn't fight the browser's clear-search behavior.
  useEffect(() => {
    if (!selectedName) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || modal) return;
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable) return;
      }
      setSelectedName(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedName, modal]);
  // ?selected=<name> deep-link redirect: navigate to hub so the user
  // always lands on the full recipe hub page regardless of entry point.
  // This keeps links from suggestions/page.tsx working while ensuring
  // keyboard and mouse navigation are identical (both go to the hub).
  useEffect(() => {
    if (!selectedName) return;
    router.replace(
      `/recipes/${encodeURIComponent(canonicalRecipeKey(selectedName))}`,
    );
  // Run once on mount (when selectedName comes from ?selected= param).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const deepLinkConsumedRef = useRef(false);

  // Mirror selectedName → URL `?selected=<name>` via replaceState so the
  // detail-panel selection survives refresh and is shareable. Uses
  // replaceState (not router.push) to avoid history spam on every click.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const current = url.searchParams.get("selected");
    if (selectedName) {
      if (current === selectedName) return;
      url.searchParams.set("selected", selectedName);
    } else {
      if (current === null) return;
      url.searchParams.delete("selected");
    }
    window.history.replaceState(null, "", url.toString());
  }, [selectedName]);

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
      // Recovered: clear the transient unsupported flag so a single 404
      // followed by a 200 doesn't strand the UI in the empty state.
      setUnsupported(false);
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
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id == null) id = setInterval(() => void load(), 5000);
    };
    const stop = () => {
      if (id != null) {
        clearInterval(id);
        id = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void load();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  // #600: deep-link consumer. Fires once after recipes load if the URL
  // has ?run=<name>. Looks up the recipe, opens the RunModal, then
  // strips the param so a back-navigation doesn't re-open the modal.
  // Silent no-op if the named recipe isn't installed — the user lands
  // on /recipes and can see the empty state / search for it.
  useEffect(() => {
    if (deepLinkConsumedRef.current) return;
    const wantRun = searchParams.get("run");
    if (!wantRun) return;
    if (!recipes) return; // wait for first load
    const match = recipes.find((r) => r.name === wantRun);
    if (match) {
      setModal({ recipe: match });
      setModalRunning(false);
    } else {
      toast.error(`Recipe '${wantRun}' is not installed.`);
    }
    deepLinkConsumedRef.current = true;
    // Drop the param so refresh / back-nav doesn't re-trigger.
    router.replace(window.location.pathname);
  }, [recipes, searchParams, router, toast]);

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
      const data = (await res.json()) as { ok: boolean; taskId?: string; seq?: number; error?: string };
      if (data.ok && data.taskId) {
        setRunning((p) => ({ ...p, [name]: `queued ${data.taskId?.slice(0, 8)}` }));
        const runsHref = data.seq != null
          ? `/runs/${data.seq}`
          : `/runs?recipe=${encodeURIComponent(name)}`;
        toast.success("Run started", {
          action: { label: "View run", onClick: () => router.push(runsHref) },
        });
        void load();
      } else {
        const errMsg =
          data.error === "already_in_flight"
            ? "Already running"
            : `error: ${data.error ?? "unknown"}`;
        setRunning((p) => ({ ...p, [name]: errMsg }));
        toast.error(`Run failed: ${data.error ?? "unknown"}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setRunning((p) => ({
        ...p,
        [name]: `error: ${msg}`,
      }));
      toast.error(`Run failed: ${msg}`);
    }
  }

  function handleRunClick(recipe: Recipe) {
    const vars = recipe.vars ?? [];
    // Vars-less recipes used to fire on first click with no confirm. We open
    // the same RunModal (which has zero fields when there are no vars, so it
    // becomes a pure confirm dialog) UNLESS the user has already acknowledged
    // a Run this session.
    if (vars.length === 0 && hasConfirmedRunThisSession()) {
      void executeRun(recipe.name);
      return;
    }
    setModal({ recipe });
    setModalRunning(false);
  }

  async function handleToggleEnabled(recipe: Recipe) {
    const target = recipe.enabled === false;
    // Disabling a non-manual trigger (cron/webhook/event) silently stops a
    // recurring job — confirm before the optimistic flip so the operator
    // doesn't kill a production schedule with a stray click.
    const trigger = recipe.trigger ?? "manual";
    const isAutonomous = trigger !== "manual";
    if (!target && isAutonomous) {
      const proceed = window.confirm(
        `Disable "${recipe.name}"? Trigger "${trigger}" will stop firing until you re-enable.`,
      );
      if (!proceed) return;
    }
    // Optimistic flip — the toggle was tap-then-wait-2s before, which felt
    // unresponsive. Roll back to the previous state if the PATCH fails.
    setRecipes((prev) =>
      prev
        ? prev.map((r) =>
            r.name === recipe.name ? { ...r, enabled: target } : r,
          )
        : prev,
    );
    try {
      const res = await fetch(
        apiPath(`/api/bridge/recipes/${encodeURIComponent(recipe.name)}`),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: target }),
        },
      );
      if (!res.ok) throw new Error(`/recipes/${recipe.name} ${res.status}`);
      // Re-sync once on success so any server-side derived fields stay
      // current (lastRun, etc.).
      void load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      // Roll back the optimistic flip.
      setRecipes((prev) =>
        prev
          ? prev.map((r) =>
              r.name === recipe.name ? { ...r, enabled: !target } : r,
            )
          : prev,
      );
    }
  }

  async function handleArchiveRecipe(recipe: Recipe) {
    const proceed = window.confirm(
      `Archive "${recipe.name}"? It will be moved to ~/.patchwork/recipes/.archive and hidden from this list. Trigger "${recipe.trigger ?? "?"}" stops firing once archived.`,
    );
    if (!proceed) return;
    try {
      const res = await fetch(
        apiPath(
          `/api/bridge/recipes/${encodeURIComponent(recipe.name)}/archive`,
        ),
        { method: "POST" },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        toast.error(`Archive failed: ${text || res.status}`);
        return;
      }
      toast.success(`Archived “${recipe.name}”`);
      setSelectedName(null);
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleDeleteRecipe(recipe: Recipe) {
    const proceed = window.confirm(
      `Permanently delete "${recipe.name}"? This removes the YAML file and any sidecar permissions. Cannot be undone.`,
    );
    if (!proceed) return;
    try {
      const res = await fetch(
        apiPath(`/api/bridge/recipes/${encodeURIComponent(recipe.name)}`),
        { method: "DELETE" },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        toast.error(`Delete failed: ${text || res.status}`);
        return;
      }
      toast.success(`Deleted “${recipe.name}”`);
      setSelectedName(null);
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleModalConfirm(vars: Record<string, string>) {
    if (!modal) return;
    const name = modal.recipe.name;
    setModalRunning(true);
    try {
      await executeRun(name, vars);
      markRunConfirmedThisSession();
    } finally {
      setModal(null);
      setModalRunning(false);
    }
  }

  // Memoize derived lists so they don't rebuild on every render — this
  // page re-renders on every SSE step event via LiveRunsContext, and
  // each rebuild was rebroadcasting a fresh array identity downstream,
  // breaking React.memo on row components. Perf audit 2026-05-19.
  // #748 follow-up: /connections links here with ?connector=<id> when a
  // user clicks the "N recipes" badge. Honour it as an additional filter
  // so the deep-link actually narrows the list. Absent param → no-op.
  const connectorFilter = searchParams.get("connector");

  const filteredRecipes = useMemo(() => {
    return (recipes ?? []).filter((r) => {
      if (statusFilter === "enabled" && r.enabled === false) return false;
      if (statusFilter === "paused" && r.enabled !== false) return false;
      if (connectorFilter && !recipeMatchesConnector(r, connectorFilter)) {
        return false;
      }
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return (
        r.name.toLowerCase().includes(q) ||
        (r.description ?? "").toLowerCase().includes(q)
      );
    });
  }, [recipes, statusFilter, search, connectorFilter]);

  const { enabledCount, pausedCount, installedCount } = useMemo(() => {
    const list = recipes ?? [];
    let on = 0;
    let off = 0;
    for (const r of list) {
      if (r.enabled === false) off++;
      else on++;
    }
    return { enabledCount: on, pausedCount: off, installedCount: list.length };
  }, [recipes]);

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

  // j/k row navigation through filteredRecipes. j → next, k → prev.
  // Wraps at ends. Skipped while typing or when a modal is open so it
  // doesn't fight inputs or override modal-local shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "j" && e.key !== "k") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (modal) return;
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable) return;
      }
      if (filteredRecipes.length === 0) return;
      e.preventDefault();
      const idx = selectedName
        ? filteredRecipes.findIndex((r) => r.name === selectedName)
        : -1;
      const delta = e.key === "j" ? 1 : -1;
      const next =
        idx === -1
          ? e.key === "j"
            ? 0
            : filteredRecipes.length - 1
          : (idx + delta + filteredRecipes.length) % filteredRecipes.length;
      const nextRecipe = filteredRecipes[next];
      const nextName = nextRecipe.name;
      // Scroll the newly-focused row into view and move DOM focus so j/k
      // feels like a cursor walk rather than a silent state change off-screen.
      requestAnimationFrame(() => {
        const row = document.querySelector<HTMLElement>(
          `[data-recipe-row="${CSS.escape(nextName)}"]`,
        );
        row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        row?.focus();
      });
      // If Enter is pressed after j/k movement the row's onKeyDown handler
      // calls router.push — same as a click. We no longer open the inline
      // RecipeDetailPanel from j/k; both input methods navigate to the hub.
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // selectedName intentionally removed from deps — j/k no longer drives
  // the side panel; it only moves DOM focus so the row can handle Enter.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredRecipes, modal]);

  return (
    <section>

      <RunModal
        state={modal}
        onClose={() => setModal(null)}
        onConfirm={handleModalConfirm}
        running={modalRunning}
      />

      <div className="page-head">
        <div>
          <div className="page-head-title-row">
            <h1 className="editorial-h1">
              Recipes — <span className="accent">YAML, declarative, yours.</span>
            </h1>
            <HintCard.Toggle id="recipes" />
          </div>
          <div className="editorial-sub">
            {recipes ? (
              <>
                <code className="mono-path">~/.patchwork/recipes</code>
                <span aria-hidden="true" className="sep-muted">·</span>
                {installedCount} installed
              </>
            ) : (
              "Loading…"
            )}
          </div>
          <RelationStrip
            items={[
              { label: "Runs", href: "/runs", title: "Runs produced by these recipes" },
              { label: "Halts", href: "/runs?halt=1", tone: "warn", title: "Runs that hit a halt reason" },
              { label: "Marketplace", href: "/marketplace", title: "Community-published recipes" },
              { label: "New recipe", href: "/recipes/new", tone: "accent", title: "Author a new recipe" },
            ]}
          />
        </div>
        <div className="page-head-actions">
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => void load()}
            title="Reload recipes"
          >
            ↻ Reload
          </button>
          <Link href="/recipes/new" className="btn primary">
            + Add recipe
          </Link>
        </div>
      </div>

      <div className="recipes-toolbar">
        <div className="recipes-search recipes-search-wrap" style={{ position: "relative" }}>
          <span aria-hidden="true" className="recipes-search-icon">⌕</span>
          <input
            ref={searchInputRef}
            type="search"
            className="input"
            placeholder="Search recipes by name or description… ( / )"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search recipes (shortcut: /)"
            style={{ paddingRight: search ? 30 : undefined, transition: "border-color 120ms" }}
          />
          {search && (
            <button
              type="button"
              className="recipes-search-clear"
              onClick={() => { setSearch(""); searchInputRef.current?.focus(); }}
              aria-label="Clear search"
              tabIndex={-1}
            >
              ✕
            </button>
          )}
        </div>
        {recipes && recipes.length > 0 && (
          <div className="recipes-toolbar-meta">
            <span>
              <strong>{filteredRecipes.length}</strong>
              {search.trim() || statusFilter !== "all" ? ` of ${installedCount}` : ""} shown
            </span>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={() => setStatusFilter(statusFilter === "enabled" ? "all" : "enabled")}
              aria-pressed={statusFilter === "enabled"}
              data-filter="enabled"
              title={statusFilter === "enabled" ? "Showing enabled only — click to clear" : "Show only enabled"}
              className="recipes-status-btn"
            >
              {enabledCount} enabled
            </button>
            {pausedCount > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  onClick={() => setStatusFilter(statusFilter === "paused" ? "all" : "paused")}
                  aria-pressed={statusFilter === "paused"}
                  data-filter="paused"
                  title={statusFilter === "paused" ? "Showing paused only — click to clear" : "Show only paused"}
                  className="recipes-status-btn"
                >
                  {pausedCount} paused
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <HintCard id="recipes" />

      {connectorFilter && (
        <div role="status" className="recipes-connector-badge">
          <span>
            Filtered by connector:{" "}
            <strong>{connectorFilter}</strong>
          </span>
          <button
            type="button"
            onClick={() => router.push("/recipes")}
            aria-label="Clear connector filter"
            title="Clear connector filter"
            className="recipes-connector-badge-clear"
          >
            ✕
          </button>
        </div>
      )}

      {err && (recipes === null || recipes.length === 0) && (
        <ErrorState
          title="Couldn't load recipes"
          description="The bridge isn't responding to /recipes. Check that the bridge is running."
          error={err}
          onRetry={() => void load()}
        />
      )}
      {err && recipes && recipes.length > 0 && (
        <div className="alert-err">Refresh failed — {err}</div>
      )}

      {recipes === null && !err ? (
        <SkeletonList rows={4} columns={3} />
      ) : recipes === null && err ? null : recipes === null || recipes.length === 0 ? (
        <EmptyState
          title="No recipes installed"
          description={
            unsupported
              ? "Recipe listing endpoint not available on this bridge version."
              : "Browse the marketplace or author your own."
          }
          action={
            <>
              <Link href="/marketplace" className="btn primary">Browse marketplace</Link>
              <Link href="/recipes/new" className="btn ghost">New recipe</Link>
            </>
          }
        />
      ) : (
        <div className={`recipes-grid${selectedRecipe ? " has-detail" : ""}`}>
          <PatchCard padded={false} className="recipes-table-card">
            <div className="table-wrap recipes-table-wrap">
              <table className="table recipes-table" aria-keyshortcuts="j k">
                <caption className="sr-only">
                  Installed recipes with health, trigger, last 14 runs, average duration, last run time, and actions.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">
                      <span className="sr-only">Health</span>
                    </th>
                    <th scope="col">Recipe</th>
                    <th scope="col">Trigger</th>
                    <th scope="col">Runs</th>
                    <th scope="col">Avg</th>
                    <th scope="col">Last</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRecipes.length === 0 && (
                    <tr>
                      <td colSpan={7} className="recipes-empty-td" style={{ padding: "40px 24px", textAlign: "center" }}>
                        <div style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          gap: 12,
                          animation: "recipeFadeIn 200ms ease both",
                        }}>
                          <div style={{ fontSize: 32, opacity: 0.3 }}>
                            {search.trim() ? "⌕" : "◎"}
                          </div>
                          <div style={{ color: "var(--ink-2)", fontSize: "var(--fs-s)", fontWeight: 500 }}>
                            {search.trim()
                              ? `No recipes match "${search.trim()}"`
                              : statusFilter === "paused"
                                ? "No paused recipes"
                                : "No enabled recipes"}
                          </div>
                          <div style={{ display: "flex", gap: 8 }}>
                            {search.trim() && (
                              <button
                                type="button"
                                className="btn sm ghost"
                                onClick={() => setSearch("")}
                              >
                                Clear search
                              </button>
                            )}
                            {statusFilter !== "all" && (
                              <button
                                type="button"
                                className="btn sm ghost"
                                onClick={() => setStatusFilter("all")}
                              >
                                Show all
                              </button>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
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
                        className={`recipe-row${sel ? " is-selected" : ""}${enabled ? "" : " is-off"}`}
                        style={{ animationDelay: `${Math.min(i * 30, 300)}ms` }}
                        data-recipe-row={r.name}
                        onClick={() => {
                          router.push(`/recipes/${encodeURIComponent(canonicalRecipeKey(r.name))}`);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            router.push(`/recipes/${encodeURIComponent(canonicalRecipeKey(r.name))}`);
                          }
                        }}
                        tabIndex={0}
                        role="link"
                        aria-label={`Open recipe ${r.name}`}
                      >
                        <td>
                          <SuccessRing pct={pct} />
                        </td>
                        <td className="mono">
                          <div className="recipe-name-row">
                            <Link
                              href={`/recipes/${encodeURIComponent(canonicalRecipeKey(r.name))}`}
                              onClick={(e) => e.stopPropagation()}
                              className="recipe-name-link"
                              title={r.description ?? r.name}
                            >
                              {r.name}
                            </Link>
                            {live && <LivePill tone="ok" />}
                            {activeRunsByName.get(r.name) && (
                              <RecipeRunInline
                                state={activeRunsByName.get(r.name) as ActiveRunState}
                                density="chip"
                              />
                            )}
                            {enabled && !live && <span className="enabled-pulse-dot" aria-label="enabled" />}
                            {!enabled && <StatusPill tone="muted">off</StatusPill>}
                            {r.lint && r.lint.ok === false && (
                              <StatusPill
                                tone="warn"
                                title={r.lint.firstError ?? `${r.lint.errorCount} lint error(s)`}
                              >
                                lint
                              </StatusPill>
                            )}
                          </div>
                          {r.description && (
                            <div className="muted recipe-desc">{r.description}</div>
                          )}
                        </td>
                        <td>
                          <div className="recipe-trigger-col">
                            <StatusPill tone={triggerTone(r.trigger)}>
                              {r.trigger ?? "manual"}
                            </StatusPill>
                            {r.schedule && (
                              <span
                                className="mono muted recipe-schedule-text"
                                title={`Cron expression: ${r.schedule}`}
                              >
                                {r.schedule}
                              </span>
                            )}
                            {r.trigger === "webhook" && r.webhookPath && (
                              <span
                                className="mono muted recipe-schedule-text"
                                title={`Webhook path: ${r.webhookPath}`}
                              >
                                {r.webhookPath}
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          <RunSparkBars
                            runs={(allRunsMap.get(r.name) ?? []).slice(0, 14)}
                            slots={14}
                            width={140}
                            height={20}
                          />
                        </td>
                        <td className="mono muted">
                          {formatDuration(avg)}
                        </td>
                        <td className="muted">
                          {last ? relTime(last.startedAt) : "—"}
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <div
                            className="recipe-actions-wrap"
                            data-enabled={enabled ? "true" : "false"}
                          >
                            <button
                              type="button"
                              role="switch"
                              aria-checked={enabled}
                              aria-label={`${enabled ? "Disable" : "Enable"} ${r.name}`}
                              title={enabled ? "Enabled — click to disable" : "Disabled — click to enable"}
                              onClick={() => void handleToggleEnabled(r)}
                              className="recipe-toggle"
                            >
                              <span
                                aria-hidden="true"
                                className="recipe-toggle-thumb"
                              />
                            </button>
                            <button
                              type="button"
                              className="btn sm recipe-run-btn"
                              onClick={() => handleRunClick(r)}
                              disabled={!enabled}
                            >
                              <span aria-hidden="true" className="recipe-run-icon">▶</span>
                              Run{r.vars && r.vars.length > 0 ? "…" : ""}
                            </button>
                          </div>
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
              onArchive={() => void handleArchiveRecipe(selectedRecipe)}
              onDelete={() => void handleDeleteRecipe(selectedRecipe)}
              running={running}
              isLive={isLive(selectedRecipe.name)}
              activeRun={activeRunsByName.get(selectedRecipe.name)}
            />
          )}
        </div>
      )}
      {selectedRecipe && (
        <MobileRunBar
          recipe={selectedRecipe}
          onRun={() => handleRunClick(selectedRecipe)}
          onClose={() => setSelectedName(null)}
          disabled={selectedRecipe.enabled === false}
        />
      )}

      {recipes && recipes.length > 0 && (
        <div className="recipes-connectors-section">
          <ConnectorHealthPanel connectors={detectConnectors(recipes)} />
        </div>
      )}
    </section>
  );
}
