"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { apiPath } from "@/lib/api";
import { StatCard } from "@/components/StatCard";
import { SkeletonStatCard } from "@/components/Skeleton";
import { fmtDuration, relTime } from "@/components/time";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";
import { useBridgeStatus } from "@/hooks/useBridgeStatus";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CircuitBreakerState {
  suspended: boolean;
  suspendedUntil: number;
  failures: number;
  openCount: number;
  lastOpenedAt: string | null;
}

interface BridgeHealth {
  status: string;
  uptimeMs: number;
  connections: number;
  extensionConnected: boolean;
  extensionVersion: string | null;
  activeSessions: number;
  extensionCircuitBreaker?: CircuitBreakerState;
  lastDisconnectReason?: string | null;
}

interface Overview {
  pendingApprovals: number;
  runningTasks: number;
  recentActivity: number;
  uptimeMs: number | null;
  toolCallDelta: string | undefined;
  activeRecipes: number;
}

interface Pending {
  callId: string;
  toolName: string;
  tier: "low" | "medium" | "high";
  requestedAt: number;
  summary?: string;
  sessionId?: string;
}

interface Recipe {
  id?: string;
  name: string;
  description?: string;
  trigger?: string;
  enabled?: boolean;
  lastRun?: number;
  source?: string;
}

interface ActivityEvent {
  kind: string;
  tool?: string;
  status?: "success" | "error";
  durationMs?: number;
  errorMessage?: string;
  timestamp?: string;
  at?: number;
  id?: number;
  event?: string;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

interface ActivationSummary {
  installedAt: number;
  firstRecipeRunAt: number | null;
  timeToFirstRecipeRunMs: number | null;
  recipeRunsTotal: number;
  recipeRunsLast7Days: number;
  activeDaysLast7: number;
  approvalCompletionRate: number | null;
  approvalsPrompted: number;
  approvalsCompleted: number;
}

interface ActivationMetricsResponse {
  summary: ActivationSummary;
}

// ---------------------------------------------------------------------------
// Provider icon helpers
// ---------------------------------------------------------------------------

const PROVIDER_COLORS: Record<string, string> = {
  slack: "#7c3aed",
  linear: "#2563eb",
  jira: "#ea580c",
  github: "#374151",
  sentry: "#dc2626",
  gmail: "#16a34a",
  google: "#2563eb",
  notion: "#374151",
  discord: "#6366f1",
  openai: "#10b981",
};

function providerColor(namespace: string): string {
  const key = namespace.toLowerCase();
  for (const [prefix, color] of Object.entries(PROVIDER_COLORS)) {
    if (key.startsWith(prefix)) return color;
  }
  // Hash-based fallback
  const hue = [...namespace].reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360;
  return `hsl(${hue}, 55%, 40%)`;
}

function ProviderIcon({ name, size = 28 }: { name: string; size?: number }) {
  const parts = name.split(".");
  const ns = parts[0] ?? name;
  const initials = ns.slice(0, 2).toUpperCase();
  const color = providerColor(ns);
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: "var(--r-2)",
        background: color,
        color: "#fff",
        fontSize: Math.round(size * 0.38),
        fontWeight: 700,
        fontFamily: "var(--font-mono)",
        flexShrink: 0,
        letterSpacing: 0,
      }}
    >
      {initials}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Greeting
// ---------------------------------------------------------------------------

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

// ---------------------------------------------------------------------------
// Activity feed helpers
// ---------------------------------------------------------------------------

function withAt(e: ActivityEvent): ActivityEvent {
  if (typeof e.at === "number") return e;
  if (e.timestamp) {
    const ms = Date.parse(e.timestamp);
    if (Number.isFinite(ms)) return { ...e, at: ms };
  }
  return { ...e, at: Date.now() };
}

function activityLabel(e: ActivityEvent): string {
  if (e.kind === "tool") {
    return e.tool ?? "unknown";
  }
  if (e.kind === "lifecycle" && e.event) {
    return e.event.replace(/_/g, " ");
  }
  return e.kind ?? "event";
}

function activityDescription(e: ActivityEvent): string {
  if (e.kind === "tool") {
    if (e.status === "error") return e.errorMessage ?? "error";
    if (typeof e.durationMs === "number") return `${e.durationMs}ms`;
    return "ok";
  }
  if (e.kind === "lifecycle" && e.metadata) {
    const { toolName, decision, sessionId } = e.metadata as Record<string, unknown>;
    if (decision && toolName) return `${decision} · ${toolName}`;
    if (sessionId) return String(sessionId).slice(0, 8);
  }
  return "";
}

// ---------------------------------------------------------------------------
// ActivityFeed
// ---------------------------------------------------------------------------

function ActivityFeed() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [updateCount, setUpdateCount] = useState(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(apiPath("/api/bridge/activity?last=20"));
        if (!res.ok || !mountedRef.current) return;
        const data = (await res.json()) as { events?: ActivityEvent[] };
        const items = (data.events ?? []).map(withAt).reverse().slice(0, 8);
        setEvents(items);
        setUpdateCount((c) => c + 1);
      } catch {
        // bridge offline — keep showing stale
      }
    };
    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", padding: "20px 22px" }}>
      {/* header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--s-2)",
          marginBottom: "var(--s-4)",
        }}
      >
        <h2 style={{ fontSize: 15, fontWeight: 700, flex: 1, margin: 0, color: "var(--ink-0)" }}>
          Live activity
        </h2>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 11,
            color: "var(--ok)",
            fontWeight: 600,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "var(--ok)",
              display: "inline-block",
            }}
          />
          live
        </span>
        {updateCount > 0 && (
          <span className="pill muted" style={{ fontSize: 11 }}>
            {updateCount} update{updateCount !== 1 ? "s" : ""}
          </span>
        )}
        <Link href="/activity" className="pill muted" style={{ fontSize: 11, textDecoration: "none" }}>
          All →
        </Link>
      </div>

      {/* rows */}
      {events.length === 0 ? (
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "var(--s-2)",
            color: "var(--ink-2)",
            fontSize: 12,
            padding: "var(--s-8) 0",
            textAlign: "center",
          }}
        >
          <span>No activity yet</span>
          <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
            Tool calls will appear here once Claude starts running tasks.
          </span>
          <Link href="/activity" style={{ fontSize: 11, color: "var(--accent)", textDecoration: "none", marginTop: "var(--s-1)" }}>
            Open activity feed →
          </Link>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {events.map((e, i) => {
            const label = activityLabel(e);
            const desc = activityDescription(e);
            const ts = e.at ?? Date.now();
            const isErr = e.status === "error";
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: stable short list
                key={e.id ?? i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--s-3)",
                  padding: "7px 10px 7px 8px",
                  borderRadius: "var(--r-s)",
                  background: i % 2 === 0 ? "rgba(0,0,0,0.015)" : "transparent",
                  minWidth: 0,
                }}
              >
                <ProviderIcon name={label} size={22} />
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11.5,
                    color: "var(--ink-0)",
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {label}
                </span>
                {desc && (
                  <span
                    className={isErr ? "pill err" : "pill ok"}
                    style={{ fontSize: 10, flexShrink: 0 }}
                  >
                    {desc}
                  </span>
                )}
                <span style={{ fontSize: 11, color: "var(--ink-2)", flexShrink: 0, marginLeft: 4 }}>
                  {relTime(ts)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MilestoneCard
// ---------------------------------------------------------------------------

interface MilestoneCardProps {
  approvals: Pending[];
  recipes: Recipe[];
  toolCalls: number;
}

function MilestoneCard({ approvals, recipes, toolCalls }: MilestoneCardProps) {
  const hasApprovals = approvals.length > 0 || toolCalls > 0;
  const hasRecipes = recipes.length > 0;

  type MilestoneItem = { t: string; done: boolean };

  let title = "First steps";
  let items: MilestoneItem[] = [
    { t: "Bridge connected", done: true },
    { t: "First approval reviewed", done: hasApprovals },
    { t: "First recipe configured", done: hasRecipes },
    { t: "10 tool calls reached", done: toolCalls >= 10 },
    { t: "100 tool calls reached", done: toolCalls >= 100 },
  ];

  if (toolCalls >= 100) {
    title = "First 100 tool calls";
    items = [
      { t: "Bridge connected", done: true },
      { t: "First approval reviewed", done: hasApprovals },
      { t: "First recipe configured", done: hasRecipes },
      { t: "10 tool calls reached", done: true },
      { t: "100 tool calls reached", done: true },
    ];
  } else if (toolCalls >= 10) {
    title = "Getting started";
  }

  const doneCount = items.filter((i) => i.done).length;
  const pct = Math.round((doneCount / items.length) * 100);

  return (
    <div className="glass-card glass-card--hover" style={{ padding: "20px 22px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 10, color: "var(--ink-2)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 3 }}>
            Milestone
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink-0)" }}>{title}</div>
        </div>
        <span className="pill muted" style={{ fontSize: 10 }}>In progress</span>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5, fontSize: 11.5, color: "var(--ink-2)" }}>
        <span>{doneCount} of {items.length} complete</span>
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>{pct}%</span>
      </div>
      <div className="progress" style={{ marginBottom: 16 }}>
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {items.map((it, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: stable static list
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              fontSize: 12,
              color: it.done ? "var(--ink-2)" : "var(--ink-0)",
              textDecoration: it.done ? "line-through" : "none",
            }}
          >
            <span
              style={{
                width: 15,
                height: 15,
                borderRadius: "50%",
                border: it.done ? "none" : "1.5px solid var(--line-2)",
                background: it.done ? "var(--accent)" : "transparent",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                fontSize: 8,
                color: "#fff",
              }}
            >
              {it.done ? "✓" : ""}
            </span>
            {it.t}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProviderDeliveryCard
// ---------------------------------------------------------------------------

interface ProviderDeliveryCardProps {
  connectedCount: number;
}

const WAVE_PROVIDERS = ["slack", "linear", "jira", "github", "sentry", "gmail", "google", "notion"];

function ProviderDeliveryCard({ connectedCount }: ProviderDeliveryCardProps) {
  const waves = [
    { label: "Wave 1", sublabel: "shipped", n: connectedCount, total: 8, color: "var(--ok)", bg: "var(--ok-soft, var(--recess))" },
    { label: "Wave 2", sublabel: "core (planned)", n: 0, total: 8, color: "var(--accent)", bg: "var(--accent-soft, var(--recess))" },
    { label: "Wave 3", sublabel: "expand (roadmap)", n: 0, total: 16, color: "var(--ink-3)", bg: "var(--recess)" },
  ];

  return (
    <div className="glass-card glass-card--hover" style={{ padding: "20px 22px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 10, color: "var(--ink-2)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 3 }}>
            Providers
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink-0)" }}>
            {connectedCount} connected
          </div>
        </div>
        <Link href="/connectors" className="btn sm ghost" style={{ textDecoration: "none", fontSize: 11 }}>
          + Connect more
        </Link>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 7, marginBottom: 16 }}>
        {WAVE_PROVIDERS.map((p) => (
          <ProviderIcon key={p} name={p} size={28} />
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {waves.map((w) => (
          <div key={w.label}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 11.5 }}>
              <span style={{ color: "var(--ink-1)", fontWeight: 500 }}>
                {w.label}{" "}
                <span style={{ color: "var(--ink-2)", fontWeight: 400 }}>· {w.sublabel}</span>
              </span>
              <span style={{ color: "var(--ink-2)", fontFamily: "var(--font-mono)" }}>
                {w.n}/{w.total}
              </span>
            </div>
            <div className="progress">
              <div
                className="progress-fill"
                style={{ width: `${w.total > 0 ? (w.n / w.total) * 100 : 0}%`, background: w.color }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline approve button
// ---------------------------------------------------------------------------

function ApproveBtnInline({ callId }: { callId: string }) {
  const [done, setDone] = useState(false);
  if (done) {
    return (
      <span className="pill ok" style={{ fontSize: 11 }}>
        Approved
      </span>
    );
  }
  return (
    <button
      type="button"
      className="btn sm success"
      style={{ minHeight: 26 }}
      onClick={async () => {
        await fetch(apiPath(`/api/bridge/approve/${callId}`), { method: "POST" });
        setDone(true);
      }}
    >
      Approve
    </button>
  );
}

// ---------------------------------------------------------------------------
// Metric parsers
// ---------------------------------------------------------------------------

function parseUptimeMs(text: string): number | null {
  if (!text) return null;
  const m = text.match(/^bridge_uptime_seconds\s+(\d+(?:\.\d+)?)/m);
  if (m) return Math.round(Number.parseFloat(m[1]) * 1000);
  return null;
}

function parseToolCallTotal(text: string): number {
  if (!text) return 0;
  let total = 0;
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const m = line.match(
      /^bridge_tool_calls_total(?:\{[^}]*\})?\s+(\d+(?:\.\d+)?)/,
    );
    if (m) total += Number.parseFloat(m[1]);
  }
  return Math.round(total);
}

function fmtActivationDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${totalSeconds % 60}s`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h ${totalMinutes % 60}m`;
  const totalDays = Math.floor(totalHours / 24);
  return `${totalDays}d ${totalHours % 24}h`;
}

function formatApprovalCompletionRate(rate: number | null): string | undefined {
  if (rate == null) return undefined;
  return `${Math.round(rate * 100)}% approvals`;
}

function activationCardValue(
  summary: ActivationSummary | null | undefined,
  unsupported: boolean,
): string {
  if (unsupported) return "Unavailable";
  if (!summary) return "—";
  if (summary.timeToFirstRecipeRunMs == null) return "Not yet";
  return fmtActivationDuration(summary.timeToFirstRecipeRunMs);
}

function activationCardFoot(
  summary: ActivationSummary | null | undefined,
  unsupported: boolean,
): string {
  if (unsupported) return "Requires a newer bridge · local only";
  if (!summary) return "Local-only activation metrics";
  if (summary.firstRecipeRunAt == null) {
    return "Run your first recipe to start tracking · local only";
  }
  return `${summary.recipeRunsLast7Days} runs in 7d · ${summary.activeDaysLast7} active days · local only`;
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function HomePage() {
  const [data, setData] = useState<Overview>({
    pendingApprovals: 0,
    runningTasks: 0,
    recentActivity: 0,
    uptimeMs: null,
    toolCallDelta: undefined,
    activeRecipes: 0,
  });
  const [approvals, setApprovals] = useState<Pending[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [providerCount, setProviderCount] = useState(0);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const prevToolCallsRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [approvalsRes, tasksRes, metricsRes, recipesRes, connectorsRes] =
          await Promise.all([
            fetch(apiPath("/api/bridge/approvals")),
            fetch(apiPath("/api/bridge/tasks")),
            fetch(apiPath("/api/bridge/metrics")),
            fetch(apiPath("/api/bridge/recipes")),
            fetch(apiPath("/api/bridge/connectors/status")),
          ]);
        if (!alive) return;
        if (!approvalsRes.ok || !tasksRes.ok) return;

        const [approvalsData, tasks, metricsText, recipesData, connectorsData] =
          await Promise.all([
            approvalsRes.json() as Promise<Pending[]>,
            tasksRes.json() as Promise<{ tasks?: { status: string }[] }>,
            metricsRes.ok ? metricsRes.text() : Promise.resolve(""),
            recipesRes.ok ? recipesRes.json() : Promise.resolve({ recipes: [] }),
            connectorsRes.ok ? connectorsRes.json() : Promise.resolve([]),
          ]);
        if (!alive) return;

        const uptime = parseUptimeMs(metricsText as string);
        const toolCalls = parseToolCallTotal(metricsText as string);
        const recipeList: Recipe[] = Array.isArray(recipesData)
          ? recipesData
          : (recipesData as { recipes?: Recipe[] }).recipes ?? [];

        const connectorList: { name: string; status: string }[] = Array.isArray(connectorsData)
          ? connectorsData
          : (connectorsData as { connectors?: { name: string; status: string }[] }).connectors ?? [];
        setProviderCount(connectorList.filter((c) => c.status === "connected").length);

        const prev = prevToolCallsRef.current;
        const delta =
          prev !== undefined && toolCalls >= prev ? `+${toolCalls - prev}` : undefined;
        prevToolCallsRef.current = toolCalls;

        setApprovals(Array.isArray(approvalsData) ? approvalsData : []);
        setRecipes(recipeList.slice(0, 6));
        setOverviewLoading(false);
        setData({
          pendingApprovals: Array.isArray(approvalsData) ? approvalsData.length : 0,
          runningTasks: (tasks.tasks ?? []).filter(
            (t) => t.status === "running" || t.status === "pending",
          ).length,
          recentActivity: toolCalls,
          uptimeMs: uptime,
          toolCallDelta: delta,
          activeRecipes: recipeList.filter((r) => r.enabled !== false).length,
        });
      } catch {
        if (!alive) return;
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const bridgeStatus = useBridgeStatus();
  const { data: health } = useBridgeFetch<BridgeHealth>("/api/bridge/health", {
    intervalMs: 5000,
  });
  const {
    data: activationMetrics,
    loading: activationLoading,
    unsupported: activationUnsupported,
  } = useBridgeFetch<ActivationMetricsResponse>("/api/bridge/activation-metrics", {
    intervalMs: 5000,
    unsupportedValue: null,
  });

  const greet = greeting();
  const recipeCount = data.activeRecipes;
  const pendingCount = data.pendingApprovals;
  const toolCalls = data.recentActivity;
  const activationSummary = activationMetrics?.summary ?? null;
  const statLoading = overviewLoading || activationLoading;

  return (
    <section>
      {/* ------------------------------------------------------------------ */}
      {/* Hero status bar                                                       */}
      {/* ------------------------------------------------------------------ */}
      <div
        className="card"
        style={{
          position: "relative",
          overflow: "hidden",
          padding: "28px 32px",
          marginBottom: "var(--s-6)",
          background: "linear-gradient(135deg, var(--card-bg) 0%, rgba(var(--orange-rgb),0.04) 100%)",
          borderColor: "rgba(var(--orange-rgb),0.15)",
        }}
      >
        {/* subtle background accent */}
        <div aria-hidden="true" style={{
          position: "absolute",
          top: -60,
          right: -60,
          width: 200,
          height: 200,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(var(--orange-rgb),0.08) 0%, transparent 70%)",
          pointerEvents: "none",
        }} />

        <div style={{ position: "relative", display: "flex", alignItems: "center", gap: "var(--s-6)", flexWrap: "wrap" }}>
          {/* Greeting + bridge status */}
          <div style={{ flex: 1, minWidth: 200 }}>
            <h1
              style={{
                margin: 0,
                fontSize: 28,
                fontWeight: 800,
                color: "var(--ink-0)",
                lineHeight: 1.1,
                letterSpacing: "-0.025em",
              }}
            >
              {greet}
            </h1>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: 6,
                fontSize: 13,
                color: "var(--ink-2)",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: bridgeStatus.ok ? "var(--ok)" : "var(--err)",
                  display: "inline-block",
                  flexShrink: 0,
                }}
              />
              <span style={{ fontWeight: 500, color: bridgeStatus.ok ? "var(--ok)" : "var(--err)" }}>
                {bridgeStatus.ok ? "Bridge connected" : "Bridge offline"}
              </span>
              {data.uptimeMs != null && (
                <span style={{ color: "var(--ink-3)" }}>
                  · up {fmtDuration(data.uptimeMs)}
                </span>
              )}
            </div>

            {/* Extension status row */}
            {health && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginTop: 4,
                  fontSize: 12,
                  color: "var(--ink-2)",
                  flexWrap: "wrap",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: health.extensionConnected ? "var(--ok)" : "var(--ink-3)",
                    display: "inline-block",
                    flexShrink: 0,
                  }}
                />
                <span>
                  Extension{" "}
                  {health.extensionConnected ? "connected" : "disconnected"}
                  {health.extensionVersion && (
                    <span style={{ color: "var(--ink-3)", fontFamily: "var(--font-mono)", marginLeft: 4 }}>
                      v{health.extensionVersion}
                    </span>
                  )}
                </span>
                {health.extensionCircuitBreaker?.suspended && (
                  <span
                    className="pill err"
                    style={{ fontSize: 10 }}
                    title={`${health.extensionCircuitBreaker.failures} failures — suspended until ${new Date(health.extensionCircuitBreaker.suspendedUntil).toLocaleTimeString()}`}
                  >
                    circuit open · {health.extensionCircuitBreaker.failures} failures
                  </span>
                )}
                {!health.extensionCircuitBreaker?.suspended && (health.extensionCircuitBreaker?.failures ?? 0) > 0 && (
                  <span className="pill warn" style={{ fontSize: 10 }}>
                    {health.extensionCircuitBreaker!.failures} recent failure{health.extensionCircuitBreaker!.failures !== 1 ? "s" : ""}
                  </span>
                )}
                {health.lastDisconnectReason && (
                  <span style={{ color: "var(--err)", fontSize: 11 }}>
                    · last disconnect: {health.lastDisconnectReason}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Inline key numbers */}
          <div style={{ display: "flex", alignItems: "stretch", gap: "var(--s-3)", flexWrap: "wrap" }}>
            {[
              { label: "Tool calls", value: toolCalls, color: "var(--ink-0)" },
              { label: "Recipes", value: recipeCount, color: "var(--ink-0)" },
              { label: "Pending", value: pendingCount, color: pendingCount > 0 ? "var(--warn)" : "var(--ink-0)" },
            ].map(({ label, value, color }) => (
              <div
                key={label}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "10px 20px",
                  borderRadius: "var(--r-m)",
                  background: "rgba(0,0,0,0.04)",
                  border: "1px solid var(--line-1)",
                  minWidth: 72,
                  gap: 3,
                }}
              >
                <div style={{
                  fontSize: 24,
                  fontWeight: 800,
                  fontFamily: "var(--font-mono)",
                  color,
                  lineHeight: 1,
                  letterSpacing: "-0.03em",
                }}>
                  {value}
                </div>
                <div style={{ fontSize: 10, color: "var(--ink-3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  {label}
                </div>
              </div>
            ))}
          </div>

          {/* CTA if pending */}
          {pendingCount > 0 && (
            <Link
              href="/approvals"
              className="btn primary"
              style={{
                textDecoration: "none",
                background: "var(--orange)",
                border: "none",
                fontSize: 13,
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              {pendingCount} awaiting approval →
            </Link>
          )}
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Stat row                                                              */}
      {/* ------------------------------------------------------------------ */}
      <div className="stat-grid" style={{ marginBottom: "var(--s-6)" }}>
        {statLoading ? (
          <>
            <SkeletonStatCard />
            <SkeletonStatCard />
            <SkeletonStatCard />
            <SkeletonStatCard />
            <SkeletonStatCard />
          </>
        ) : (
          <>
            <StatCard
              label="Bridge uptime"
              value={data.uptimeMs != null ? fmtDuration(data.uptimeMs) : "—"}
              foot="Since last restart"
              href="/metrics"
              icon={
                <div style={{ width: 36, height: 36, borderRadius: 10, background: "rgba(13,138,94,0.12)", display: "flex", alignItems: "center", justifyContent: "center", color: "#0d8a5e" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 12H18L15 21 9 3 6 12H2"/></svg>
                </div>
              }
            />
            <StatCard
              label="Tool calls today"
              value={data.recentActivity}
              delta={data.toolCallDelta}
              foot="Total this session"
              href="/activity"
              icon={
                <div style={{ width: 36, height: 36, borderRadius: 10, background: "rgba(var(--orange-rgb), 0.12)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--orange)" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                </div>
              }
            />
            <StatCard
              label="First success"
              value={activationCardValue(activationSummary, activationUnsupported)}
              delta={formatApprovalCompletionRate(
                activationSummary?.approvalCompletionRate ?? null,
              )}
              foot={activationCardFoot(activationSummary, activationUnsupported)}
              icon={
                <div style={{ width: 36, height: 36, borderRadius: 10, background: "rgba(29,91,214,0.12)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--info)" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l2.6 5.26L20 9l-4 3.9.94 5.5L12 15.77 7.06 18.4 8 12.9 4 9l5.4-.74L12 3z"/></svg>
                </div>
              }
            />
            <StatCard
              label="Pending approvals"
              value={data.pendingApprovals}
              foot={data.pendingApprovals === 0 ? "All clear" : "Awaiting decision"}
              href="/approvals"
              icon={
                <div style={{ width: 36, height: 36, borderRadius: 10, background: "rgba(180,83,9,0.10)", display: "flex", alignItems: "center", justifyContent: "center", color: "#b45309" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z"/></svg>
                </div>
              }
            />
            <StatCard
              label="Active recipes"
              value={data.activeRecipes}
              foot="Automation recipes enabled"
              href="/recipes"
              icon={
                <div style={{ width: 36, height: 36, borderRadius: 10, background: "rgba(107,107,255,0.12)", display: "flex", alignItems: "center", justifyContent: "center", color: "#6b6bff" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 016.5 17H20M4 19.5A2.5 2.5 0 016.5 22H20V2H6.5A2.5 2.5 0 004 4.5v15zM12 7h5M12 11h5"/></svg>
                </div>
              }
            />
          </>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* 2-column main area                                                    */}
      {/* ------------------------------------------------------------------ */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1.45fr) minmax(0, 1fr)",
          gap: "var(--s-4)",
          marginBottom: "var(--s-6)",
        }}
      >
        {/* Left — Approvals queue */}
        <div className="card" style={{ display: "flex", flexDirection: "column", padding: "20px 22px" }}>
          {/* header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--s-3)",
              marginBottom: "var(--s-4)",
            }}
          >
            <h2 style={{ fontSize: 15, fontWeight: 700, flex: 1, margin: 0, color: "var(--ink-0)" }}>
              Pending approvals
            </h2>
            {pendingCount > 0 && (
              <span className="pill warn" style={{ fontSize: 11 }}>
                {pendingCount}
              </span>
            )}
            <Link
              href="/approvals"
              className="pill muted"
              style={{ fontSize: 11, textDecoration: "none" }}
            >
              Review all →
            </Link>
          </div>

          {approvals.length === 0 ? (
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "var(--s-2)",
                color: "var(--ok)",
                padding: "var(--s-10) 0",
              }}
            >
              <span
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: "50%",
                  background: "rgba(34,197,94,0.1)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 22,
                }}
              >
                ✓
              </span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>All clear</span>
              <span style={{ fontSize: 12, color: "var(--ink-2)" }}>Nothing needs your approval</span>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
              {approvals.slice(0, 4).map((p) => {
                const ns = p.toolName.split(".")[0] ?? p.toolName;
                const recipeName = p.summary ?? ns;
                const tierClass =
                  p.tier === "high" ? "err" : p.tier === "medium" ? "warn" : "muted";
                return (
                  <div
                    key={p.callId}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--s-3)",
                      padding: "10px 12px",
                      background: "var(--recess)",
                      borderRadius: "var(--r-m)",
                      flexWrap: "wrap",
                    }}
                  >
                    <ProviderIcon name={p.toolName} size={30} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 12,
                          color: "var(--ink-0)",
                          fontWeight: 600,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {p.toolName}
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--ink-2)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          marginTop: 2,
                        }}
                      >
                        {recipeName} · {relTime(p.requestedAt)}
                      </div>
                    </div>
                    <span className={`pill ${tierClass}`} style={{ fontSize: 10, flexShrink: 0 }}>
                      {p.tier}
                    </span>
                    <div style={{ display: "flex", gap: "var(--s-2)", flexShrink: 0 }}>
                      <ApproveBtnInline callId={p.callId} />
                      <Link
                        href={`/approvals/${p.callId}`}
                        className="btn sm ghost"
                        style={{ textDecoration: "none", minHeight: 26 }}
                      >
                        Details →
                      </Link>
                    </div>
                  </div>
                );
              })}
              {approvals.length > 4 && (
                <div
                  style={{
                    textAlign: "center",
                    fontSize: 12,
                    color: "var(--ink-2)",
                    paddingTop: "var(--s-2)",
                  }}
                >
                  + {approvals.length - 4} more —{" "}
                  <Link href="/approvals" style={{ color: "var(--accent)" }}>
                    see all
                  </Link>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right — Live activity */}
        <ActivityFeed />
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* 3-column bottom section                                               */}
      {/* ------------------------------------------------------------------ */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: "var(--s-4)",
          marginBottom: "var(--s-6)",
        }}
      >
        {/* Card A — Active recipes */}
        <div className="glass-card glass-card--hover" style={{ padding: "20px 22px", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--s-2)", marginBottom: "var(--s-4)" }}>
            <h2 style={{ fontSize: 15, fontWeight: 700, flex: 1, margin: 0, color: "var(--ink-0)" }}>
              Active recipes
            </h2>
            <Link
              href="/recipes"
              className="pill muted"
              style={{ fontSize: 11, textDecoration: "none" }}
            >
              View all →
            </Link>
          </div>

          {recipes.length === 0 ? (
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "var(--s-3)",
                padding: "var(--s-6) 0",
                textAlign: "center",
              }}
            >
              <span style={{ fontSize: 12, color: "var(--ink-2)" }}>No recipes configured yet</span>
              <div style={{ display: "flex", gap: "var(--s-2)" }}>
                <Link href="/marketplace" className="btn sm primary" style={{ textDecoration: "none", fontSize: 11 }}>
                  Browse marketplace
                </Link>
                <Link href="/recipes/new" className="btn sm ghost" style={{ textDecoration: "none", fontSize: 11 }}>
                  New recipe
                </Link>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)", flex: 1 }}>
              {recipes.slice(0, 4).map((r, i) => {
                const isRunning = r.enabled !== false;
                const lastRunText = r.lastRun ? relTime(r.lastRun) : "never";
                return (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: stable short list
                    key={r.id ?? i}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--s-3)",
                      padding: "8px 10px",
                      borderRadius: "var(--r-s)",
                      background: "rgba(0,0,0,0.02)",
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 12.5,
                          fontWeight: 600,
                          color: "var(--ink-0)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {r.name}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--ink-2)", marginTop: 1 }}>
                        last run {lastRunText}
                      </div>
                    </div>
                    {r.trigger && (
                      <span className="pill muted" style={{ fontSize: 9, flexShrink: 0 }}>
                        {r.trigger}
                      </span>
                    )}
                    <span
                      className={`pill ${isRunning ? "ok" : "muted"}`}
                      style={{ fontSize: 9, flexShrink: 0 }}
                    >
                      {isRunning ? "on" : "off"}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          <div
            style={{
              marginTop: "var(--s-3)",
              paddingTop: "var(--s-3)",
              borderTop: "1px solid var(--line-3)",
            }}
          >
            <Link
              href="/recipes"
              style={{ fontSize: 12, color: "var(--accent)", textDecoration: "none", fontWeight: 500 }}
            >
              Manage recipes →
            </Link>
          </div>
        </div>

        {/* Card B — Connected providers */}
        <ProviderDeliveryCard connectedCount={providerCount} />

        {/* Card C — Milestone tracker */}
        <MilestoneCard approvals={approvals} recipes={recipes} toolCalls={toolCalls} />
      </div>
    </section>
  );
}
