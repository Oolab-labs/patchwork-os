"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { apiPath } from "@/lib/api";
import { StatCard } from "@/components/StatCard";
import { fmtDuration, relTime } from "@/components/time";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BridgeHealth {
  status: string;
  uptimeMs: number;
  connections: number;
  extensionConnected: boolean;
  extensionVersion: string;
  activeSessions: number;
}

interface Overview {
  pendingApprovals: number;
  runningTasks: number;
  recentActivity: number;
  uptimeMs: number | null;
  bridgeOk: boolean;
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
// Activity feed (client component — needs its own interval)
// ---------------------------------------------------------------------------

function withAt(e: ActivityEvent): ActivityEvent {
  if (typeof e.at === "number") return e;
  if (e.timestamp) {
    const ms = Date.parse(e.timestamp);
    if (Number.isFinite(ms)) return { ...e, at: ms };
  }
  return { ...e, at: Date.now() };
}

function activityBorderColor(e: ActivityEvent): string {
  if (e.status === "error") return "var(--err)";
  if (e.kind === "tool" && e.status === "success") return "var(--ok)";
  if (e.event === "approval_decision") {
    const dec = e.metadata?.decision;
    if (dec === "approve") return "var(--ok)";
    if (dec === "reject") return "var(--err)";
  }
  return "var(--warn)";
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

function ActivityFeed() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [updateCount, setUpdateCount] = useState(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
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
    <div className="glass-card glass-card--hover" style={{ display: "flex", flexDirection: "column" }}>
      {/* header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--s-2)",
          marginBottom: "var(--s-4)",
          flexWrap: "wrap",
        }}
      >
        <h2 style={{ fontSize: 15, flex: 1, margin: 0 }}>Bridge activity</h2>
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
              width: 6,
              height: 6,
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
            alignItems: "center",
            justifyContent: "center",
            color: "var(--fg-3)",
            fontSize: 13,
            padding: "var(--s-8) 0",
          }}
        >
          No recent activity
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {events.map((e, i) => {
            const label = activityLabel(e);
            const desc = activityDescription(e);
            const ts = e.at ?? Date.now();
            const borderColor = activityBorderColor(e);
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: stable short list
                key={e.id ?? i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--s-3)",
                  padding: "6px var(--s-3)",
                  borderRadius: "var(--r-2)",
                  borderLeft: `2px solid ${borderColor}`,
                  background: "rgba(255,255,255,0.02)",
                  minWidth: 0,
                }}
              >
                <ProviderIcon name={label} size={24} />
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    color: "var(--fg-0)",
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
                    style={{
                      fontSize: 11,
                      color: "var(--fg-3)",
                      flexShrink: 0,
                      maxWidth: 100,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {desc}
                  </span>
                )}
                <span style={{ fontSize: 11, color: "var(--fg-3)", flexShrink: 0 }}>
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
// MilestoneCard — progress toward the current usage milestone
// ---------------------------------------------------------------------------

interface MilestoneCardProps {
  approvals: Pending[];
  recipes: Recipe[];
  toolCalls: number;
}

function MilestoneCard({ approvals, recipes, toolCalls }: MilestoneCardProps) {
  // Derive which milestone is active from real data
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
          <div style={{ fontSize: 11, color: "var(--fg-3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 2 }}>
            Current milestone
          </div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--fg-0)" }}>{title}</div>
        </div>
        <span className="pill muted" style={{ fontSize: 11 }}>In progress</span>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5, fontSize: 12, color: "var(--fg-2)" }}>
        <span>{doneCount} of {items.length} complete</span>
        <span style={{ fontFamily: "var(--font-mono)" }}>{pct}%</span>
      </div>
      <div className="progress" style={{ marginBottom: 16 }}>
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map((it, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: stable static list
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              fontSize: 12.5,
              color: it.done ? "var(--fg-3)" : "var(--fg-0)",
              textDecoration: it.done ? "line-through" : "none",
            }}
          >
            <span
              style={{
                width: 14,
                height: 14,
                borderRadius: "50%",
                border: it.done ? "none" : "1.5px solid var(--border)",
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
// ProviderDeliveryCard — connected providers + wave breakdown
// ---------------------------------------------------------------------------

interface ProviderDeliveryCardProps {
  connectedCount: number;
}

const WAVE_PROVIDERS = ["slack", "linear", "jira", "github", "sentry", "gmail", "google", "notion"];

function ProviderDeliveryCard({ connectedCount }: ProviderDeliveryCardProps) {
  const waves = [
    { label: "Wave 1", sublabel: "shipped", n: connectedCount, total: 8, color: "var(--ok)", bg: "var(--ok-soft, var(--recess))" },
    { label: "Wave 2", sublabel: "core (planned)", n: 0, total: 8, color: "var(--accent)", bg: "var(--accent-soft, var(--recess))" },
    { label: "Wave 3", sublabel: "expand (roadmap)", n: 0, total: 16, color: "var(--fg-3)", bg: "var(--recess)" },
  ];

  return (
    <div className="glass-card glass-card--hover" style={{ padding: "20px 22px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 11, color: "var(--fg-3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 2 }}>
            Provider delivery
          </div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--fg-0)" }}>
            {connectedCount} of 32 connected
          </div>
        </div>
        <Link href="/connectors" className="btn sm ghost" style={{ textDecoration: "none", fontSize: 12 }}>
          + Connect
        </Link>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 6, marginBottom: 14 }}>
        {WAVE_PROVIDERS.map((p) => (
          <ProviderIcon key={p} name={p} size={28} />
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {waves.map((w) => (
          <div key={w.label}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 12 }}>
              <span style={{ color: "var(--fg-1)", fontWeight: 500 }}>
                {w.label} ·{" "}
                <span style={{ color: "var(--fg-3)", fontWeight: 400 }}>{w.sublabel}</span>
              </span>
              <span style={{ color: "var(--fg-2)", fontFamily: "var(--font-mono)" }}>
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
// Main page
// ---------------------------------------------------------------------------

export default function HomePage() {
  const [data, setData] = useState<Overview>({
    pendingApprovals: 0,
    runningTasks: 0,
    recentActivity: 0,
    uptimeMs: null,
    bridgeOk: false,
    toolCallDelta: undefined,
    activeRecipes: 0,
  });
  const [approvals, setApprovals] = useState<Pending[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [providerCount, setProviderCount] = useState(0);
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
        if (!approvalsRes.ok || !tasksRes.ok) {
          setData((prev) => ({ ...prev, bridgeOk: false }));
          return;
        }

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

        // providerCount: count connectors with status "connected"
        const connectorList: { name: string; status: string }[] = Array.isArray(connectorsData)
          ? connectorsData
          : (connectorsData as { connectors?: { name: string; status: string }[] }).connectors ?? [];
        setProviderCount(connectorList.filter((c) => c.status === "connected").length);

        // toolCallDelta: diff from previous poll
        const prev = prevToolCallsRef.current;
        const delta = prev !== undefined && toolCalls >= prev
          ? `+${toolCalls - prev}`
          : undefined;
        prevToolCallsRef.current = toolCalls;

        setApprovals(Array.isArray(approvalsData) ? approvalsData : []);
        setRecipes(recipeList.slice(0, 6));
        setData({
          pendingApprovals: Array.isArray(approvalsData) ? approvalsData.length : 0,
          runningTasks: (tasks.tasks ?? []).filter(
            (t) => t.status === "running" || t.status === "pending",
          ).length,
          recentActivity: toolCalls,
          uptimeMs: uptime,
          bridgeOk: true,
          toolCallDelta: delta,
          activeRecipes: recipeList.filter((r) => r.enabled !== false).length,
        });
      } catch {
        if (!alive) return;
        setData((prev) => ({ ...prev, bridgeOk: false }));
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const { data: health } = useBridgeFetch<BridgeHealth>("/api/bridge/health", {
    intervalMs: 5000,
  });

  const greet = greeting();
  const recipeCount = data.activeRecipes;
  const pendingCount = data.pendingApprovals;

  return (
    <section>
      {/* ------------------------------------------------------------------ */}
      {/* Greeting header                                                      */}
      {/* ------------------------------------------------------------------ */}
      <div className="page-head">
        <div>
          <h1>
            {greet}, <span style={{ color: "var(--accent-strong)" }}>mr.</span>
          </h1>
          <div className="page-head-sub">
            Patchwork OS is running{" "}
            <strong style={{ color: "var(--fg-1)" }}>{recipeCount}</strong>{" "}
            recipe{recipeCount !== 1 ? "s" : ""} across{" "}
            <strong style={{ color: "var(--fg-1)" }}>{providerCount}</strong>{" "}
            provider{providerCount !== 1 ? "s" : ""}.{" "}
            {pendingCount > 0 ? (
              <>
                <Link href="/approvals" style={{ color: "var(--warn)" }}>
                  {pendingCount} tool call{pendingCount !== 1 ? "s" : ""} need
                  {pendingCount === 1 ? "s" : ""} your approval.
                </Link>
              </>
            ) : (
              "No tool calls need your approval."
            )}
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Stat cards                                                           */}
      {/* ------------------------------------------------------------------ */}
      <div className="stat-grid">
        <StatCard
          label="Bridge uptime"
          value={data.uptimeMs != null ? fmtDuration(data.uptimeMs) : "—"}
          foot="Since last restart"
          href="/metrics"
        />
        <StatCard
          label="Tool calls today"
          value={data.recentActivity}
          delta={data.toolCallDelta}
          foot="Total this session"
          href="/activity"
        />
        <StatCard
          label="Pending approvals"
          value={data.pendingApprovals}
          foot={data.pendingApprovals === 0 ? "All clear" : "Awaiting decision"}
          href="/approvals"
        />
        <StatCard
          label="Active recipes"
          value={data.activeRecipes}
          foot="Automation recipes enabled"
          href="/recipes"
        />
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* 2-column main grid                                                   */}
      {/* ------------------------------------------------------------------ */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.1fr 1fr",
          gap: "var(--s-4)",
          marginBottom: "var(--s-6)",
        }}
      >
        {/* Left — Pending approvals preview */}
        <div className="glass-card glass-card--hover" style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--s-2)",
              marginBottom: "var(--s-4)",
              flexWrap: "wrap",
            }}
          >
            <h2 style={{ fontSize: 15, flex: 1, margin: 0 }}>
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
                alignItems: "center",
                justifyContent: "center",
                flexDirection: "column",
                gap: "var(--s-2)",
                color: "var(--ok)",
                fontSize: 13,
                padding: "var(--s-8) 0",
              }}
            >
              <span style={{ fontSize: 20 }}>✓</span>
              All caught up!
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
              {approvals.slice(0, 3).map((p) => {
                const ns = p.toolName.split(".")[0] ?? p.toolName;
                const recipeName = p.summary ?? ns;
                return (
                  <div
                    key={p.callId}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--s-3)",
                      padding: "var(--s-3) var(--s-3)",
                      background: "rgba(255,255,255,0.02)",
                      borderRadius: "var(--r-2)",
                      flexWrap: "wrap",
                    }}
                  >
                    <ProviderIcon name={p.toolName} size={28} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 12,
                          color: "var(--fg-0)",
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
                          color: "var(--fg-3)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          marginTop: 1,
                        }}
                      >
                        {recipeName}
                      </div>
                    </div>
                    <span
                      className={`pill ${p.tier === "high" ? "err" : p.tier === "medium" ? "warn" : "muted"}`}
                      style={{ fontSize: 10 }}
                    >
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
              {approvals.length > 3 && (
                <div
                  style={{
                    textAlign: "center",
                    fontSize: 12,
                    color: "var(--fg-3)",
                    paddingTop: "var(--s-2)",
                  }}
                >
                  + {approvals.length - 3} more —{" "}
                  <Link href="/approvals">see all</Link>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right — Bridge activity feed */}
        <ActivityFeed />
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Bottom grid — Milestone + Provider delivery                          */}
      {/* ------------------------------------------------------------------ */}
      <section className="overview-bottom-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: "var(--s-6)" }}>
        <MilestoneCard approvals={approvals} recipes={recipes} toolCalls={data.recentActivity} />
        <ProviderDeliveryCard connectedCount={providerCount} />
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Active recipes section                                               */}
      {/* ------------------------------------------------------------------ */}
      {recipes.length > 0 && (
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--s-3)",
              marginBottom: "var(--s-4)",
            }}
          >
            <h2 style={{ margin: 0, fontSize: 16 }}>Active recipes</h2>
            <Link
              href="/recipes"
              className="pill muted"
              style={{ fontSize: 11, textDecoration: "none", marginLeft: "auto" }}
            >
              View all recipes →
            </Link>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
              gap: "var(--s-4)",
            }}
          >
            {recipes.map((r, i) => {
              const isRunning = r.enabled !== false;
              const lastRunText = r.lastRun ? relTime(r.lastRun) : "never";
              return (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: stable short list
                  key={r.id ?? i}
                  className="glass-card glass-card--hover"
                  style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}
                >
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--s-2)" }}>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: "var(--fg-0)",
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.name}
                    </div>
                    <span className={`pill ${isRunning ? "ok" : "muted"}`} style={{ fontSize: 10, flexShrink: 0 }}>
                      {isRunning ? "Running" : "Idle"}
                    </span>
                  </div>
                  {r.description && (
                    <div
                      style={{
                        fontSize: 12,
                        color: "var(--fg-3)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.description}
                    </div>
                  )}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--s-2)",
                      marginTop: "auto",
                      paddingTop: "var(--s-2)",
                    }}
                  >
                    {r.trigger && (
                      <span className="pill muted" style={{ fontSize: 10 }}>
                        {r.trigger}
                      </span>
                    )}
                    <span style={{ fontSize: 11, color: "var(--fg-3)", marginLeft: "auto" }}>
                      last run {lastRunText}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Inline approve button (needs its own state)
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
// Metric parsers (unchanged from original)
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
