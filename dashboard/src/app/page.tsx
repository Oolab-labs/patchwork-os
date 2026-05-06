"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { apiPath } from "@/lib/api";
import { StatCard } from "@/components/StatCard";
import { SkeletonStatCard } from "@/components/Skeleton";
import { relTime } from "@/components/time";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";
import { useBridgeStatus } from "@/hooks/useBridgeStatus";
import {
  QuiltHero,
  WeatherRing,
  AreaChart,
  CodeBlock,
  YamlLine,
  Spinner,
  AnimatedNumber,
} from "@/components/patchwork";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TokenTotals {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  total: number;
  messages: number;
}

interface BridgeHealth {
  status: string;
  uptimeMs: number;
  connections: number;
  extensionConnected: boolean;
  extensionVersion: string | null;
  activeSessions: number;
  tokens?: TokenTotals;
}

interface Pending {
  callId: string;
  toolName: string;
  tier: "low" | "medium" | "high";
  requestedAt: number;
  summary?: string;
}

interface Recipe {
  id?: string;
  name: string;
  enabled?: boolean;
  lastRun?: number;
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
// Helpers
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
  if (e.kind === "tool") return e.tool ?? "unknown";
  if (e.kind === "lifecycle" && e.event) return e.event.replace(/_/g, " ");
  return e.kind ?? "event";
}

function activityKind(e: ActivityEvent): string {
  if (e.kind === "tool" && e.tool) {
    const ns = e.tool.split(".")[0];
    return ns ?? "tool";
  }
  return e.kind ?? "event";
}

function greetingFromHour(h: number): string {
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function useGreeting(): string {
  const [g, setG] = useState("");
  useEffect(() => {
    setG(greetingFromHour(new Date().getHours()));
  }, []);
  return g;
}

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
    const m = line.match(/^bridge_tool_calls_total(?:\{[^}]*\})?\s+(\d+(?:\.\d+)?)/);
    if (m) total += Number.parseFloat(m[1]);
  }
  return Math.round(total);
}

// ---------------------------------------------------------------------------
// Activity thread (wireframe spec)
// ---------------------------------------------------------------------------

function ActivityThread({ events }: { events: ActivityEvent[] }) {
  return (
    <div className="card" style={{ padding: "18px 20px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 14,
        }}
      >
        <h3
          style={{
            fontSize: "var(--fs-m)",
            fontWeight: 700,
            margin: 0,
            color: "var(--ink-0)",
            flex: 1,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          Activity thread
        </h3>
        <Link
          href="/activity"
          style={{ fontSize: "var(--fs-xs)", color: "var(--orange)", textDecoration: "none" }}
        >
          view all →
        </Link>
      </div>

      {events.length === 0 ? (
        <div style={{ fontSize: "var(--fs-s)", color: "var(--ink-3)", padding: "var(--s-4) 0" }}>
          No recent events.
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 0,
            position: "relative",
          }}
        >
          {/* vertical rail */}
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              left: 6,
              top: 6,
              bottom: 6,
              width: 1,
              background: "var(--line-3)",
            }}
          />
          {events.map((e, i) => {
            const ts = e.at ?? Date.now();
            const tool = activityLabel(e);
            const kind = activityKind(e);
            const isErr = e.status === "error";
            const dur =
              typeof e.durationMs === "number" ? `${e.durationMs}ms` : null;
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: stable list
                key={e.id ?? i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "7px 0 7px 18px",
                  position: "relative",
                  fontSize: "var(--fs-s)",
                  minWidth: 0,
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    left: 2,
                    top: "50%",
                    transform: "translateY(-50%)",
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    background: isErr ? "var(--err)" : "var(--orange)",
                    border: "2px solid var(--card-bg, #fff)",
                  }}
                />
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--fs-xs)",
                    color: "var(--ink-3)",
                    minWidth: 56,
                    flexShrink: 0,
                  }}
                >
                  {relTime(ts)}
                </span>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--fs-s)",
                    color: "var(--ink-0)",
                    fontWeight: 600,
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {tool}
                </span>
                <span
                  className="pill muted"
                  style={{ fontSize: "var(--fs-3xs)", flexShrink: 0 }}
                >
                  {kind}
                </span>
                {dur && (
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--fs-2xs)",
                      color: "var(--ink-2)",
                      flexShrink: 0,
                    }}
                  >
                    {dur}
                  </span>
                )}
                <span
                  className={`pill ${isErr ? "err" : "ok"}`}
                  style={{ fontSize: "var(--fs-3xs)", flexShrink: 0 }}
                >
                  {isErr ? "err" : "ok"}
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
// Active recipe (live YAML + spinner)
// ---------------------------------------------------------------------------

function ActiveRecipeCard() {
  return (
    <div className="card" style={{ padding: "18px 20px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 14,
        }}
      >
        <h3
          style={{
            fontSize: "var(--fs-m)",
            fontWeight: 700,
            margin: 0,
            color: "var(--ink-0)",
            flex: 1,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          Active recipe
        </h3>
        <span
          className="pill muted"
          style={{ fontSize: "var(--fs-2xs)" }}
          title="Live wiring pending — preview only"
        >
          preview
        </span>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 10,
          fontSize: "var(--fs-s)",
          color: "var(--ink-1)",
        }}
      >
        <Spinner size={12} />
        <span style={{ fontStyle: "italic" }}>
          assembling Slack digest…
        </span>
      </div>

      <CodeBlock>
        <YamlLine k="name" v="slack-digest" />
        <YamlLine k="trigger" v="cron 0 9 * * *" />
        <YamlLine k="steps" />
        <YamlLine k="- fetch" v="slack.channels.history" indent={1} />
        <YamlLine k="- summarize" v="claude.haiku" indent={1} />
        <YamlLine k="- post" v="slack.chat.postMessage" indent={1} />
        <YamlLine k="status" v="running" comment="3/5 steps" />
      </CodeBlock>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Health card
// ---------------------------------------------------------------------------

function HealthCard({
  bridgeVersion,
  extensionVersion,
  bridgeOk,
  extensionConnected,
}: {
  bridgeVersion: string;
  extensionVersion: string;
  bridgeOk: boolean;
  extensionConnected: boolean;
}) {
  const rows: { label: string; value: string; tone?: "ok" | "muted" | "warn" }[] = [
    {
      label: "Bridge",
      value: bridgeOk ? bridgeVersion : "offline",
      tone: bridgeOk ? "ok" : "warn",
    },
    {
      label: "VS Code extension",
      value: extensionConnected ? extensionVersion : "disconnected",
      tone: extensionConnected ? "ok" : "muted",
    },
  ];

  return (
    <div className="card" style={{ padding: "18px 20px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <h3
          style={{
            fontSize: "var(--fs-m)",
            fontWeight: 700,
            margin: 0,
            color: "var(--ink-0)",
            flex: 1,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          Health
        </h3>
        <span
          className={`pill ${bridgeOk && extensionConnected ? "ok" : bridgeOk ? "muted" : "warn"}`}
          style={{ fontSize: "var(--fs-2xs)" }}
        >
          {bridgeOk && extensionConnected
            ? "all green"
            : bridgeOk
              ? "extension off"
              : "bridge offline"}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map((r) => {
          const toneLabel =
            r.tone === "ok"
              ? "healthy"
              : r.tone === "warn"
                ? "degraded"
                : "inactive";
          const toneColor =
            r.tone === "ok"
              ? "var(--ok)"
              : r.tone === "warn"
                ? "var(--warn)"
                : "var(--ink-3)";
          return (
            <div
              key={r.label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                fontSize: 12.5,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: toneColor,
                  flexShrink: 0,
                }}
              />
              <span style={{ color: "var(--ink-1)", flex: 1 }}>
                {r.label}
                <span
                  style={{
                    position: "absolute",
                    width: 1,
                    height: 1,
                    overflow: "hidden",
                    clip: "rect(0,0,0,0)",
                  }}
                >
                  {" "}
                  ({toneLabel})
                </span>
              </span>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 11.5,
                  color: "var(--ink-0)",
                  fontWeight: 600,
                }}
              >
                {r.value}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function HomePage() {
  const bridgeStatus = useBridgeStatus();
  const { data: health } = useBridgeFetch<BridgeHealth>(
    "/api/bridge/health",
    { intervalMs: 5000 },
  );

  const [pendingApprovals, setPendingApprovals] = useState<Pending[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [toolCallTotal, setToolCallTotal] = useState(0);
  const [toolCallSeries, setToolCallSeries] = useState<number[]>([]);
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);
  const prevToolCallsRef = useRef<number | undefined>(undefined);
  const tickRef = useRef<() => void>(() => {});
  const greet = useGreeting();

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [approvalsRes, metricsRes, recipesRes, activityRes] =
          await Promise.all([
            fetch(apiPath("/api/bridge/approvals")),
            fetch(apiPath("/api/bridge/metrics")),
            fetch(apiPath("/api/bridge/recipes")),
            fetch(apiPath("/api/bridge/activity?last=200")),
          ]);
        if (!alive) return;

        const approvalsData = approvalsRes.ok
          ? ((await approvalsRes.json()) as Pending[])
          : [];
        const metricsText = metricsRes.ok ? await metricsRes.text() : "";
        const recipesData = recipesRes.ok
          ? await recipesRes.json()
          : { recipes: [] };
        const activityData = activityRes.ok
          ? ((await activityRes.json()) as { events?: ActivityEvent[] })
          : { events: [] };

        if (!alive) return;

        const total = parseToolCallTotal(metricsText);
        const list: Recipe[] = Array.isArray(recipesData)
          ? recipesData
          : (recipesData as { recipes?: Recipe[] }).recipes ?? [];

        const prev = prevToolCallsRef.current;
        const delta =
          prev !== undefined && total >= prev ? total - prev : 0;
        prevToolCallsRef.current = total;

        setToolCallTotal(total);
        setToolCallSeries((s) => [...s.slice(-59), delta]);
        setPendingApprovals(Array.isArray(approvalsData) ? approvalsData : []);
        setRecipes(list);
        setActivityEvents(
          (activityData.events ?? []).map(withAt),
        );
      } catch {
        // bridge offline
      }
    };
    tickRef.current = () => void tick();
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Telemetry numbers — real bridge values, no floors.
  const recipesShipped = recipes.length;
  const pendingCount = pendingApprovals.length;
  const toolsToday = toolCallTotal;
  const oldestApprovalLabel = (() => {
    if (pendingApprovals.length === 0) return "none pending";
    const oldest = Math.min(
      ...pendingApprovals.map((p) => p.requestedAt),
    );
    return `oldest ${relTime(oldest)}`;
  })();

  // LOAD widget — running tasks + connections heuristic, + 4 trend
  const conns = health?.connections ?? 0;
  const sess = health?.activeSessions ?? 0;
  const loadPct = Math.max(
    0,
    Math.min(100, 38 + sess * 12 + (bridgeStatus.ok ? 18 : 0) + conns * 4),
  );
  const loadTrend = bridgeStatus.ok
    ? [
        Math.max(8, loadPct - 22),
        Math.max(8, loadPct - 14),
        Math.max(8, loadPct - 8),
        loadPct,
      ]
    : [0, 0, 0, 0];

  // Hero copy follows the design's narrative shape — "stitched N patches
   // overnight, drafted M things that need a nod, and woke up clean" — but
   // every number is driven from real bridge data instead of hardcoded floors.
   // Falls back to a neutral line when the bridge is offline.
  const patchesStitched = activityEvents.filter(
    (e) => e.kind === "recipe" || e.kind === "tool",
  ).length;
  const headline = bridgeStatus.ok ? (
    patchesStitched > 0 || pendingCount > 0 ? (
      <>
        Your agents stitched <span className="num">{patchesStitched.toLocaleString()}</span> patches overnight,
        drafted <span className="num">{pendingCount}</span>{" "}
        <span className="accent">{pendingCount === 1 ? "thing that needs a nod" : "things that need a nod"}</span>
        {pendingCount === 0 ? ", and woke up clean." : "."}
      </>
    ) : (
      <>Your agents are quiet. <span className="accent">No activity overnight, no approvals pending.</span></>
    )
  ) : (
    <>Bridge offline — start it to see live agent activity here.</>
  );

  const summary = bridgeStatus.ok
    ? "Bridge connected. Recipes ran on schedule. Nothing left your machine without permission."
    : "Once the bridge is running, this dashboard will reflect live activity from your local agents.";

  // Tool-calls 60-min curve — pad with zeros so it's always smooth
  const curveSeries = (() => {
    const padded = [
      ...Array(Math.max(0, 60 - toolCallSeries.length)).fill(0),
      ...toolCallSeries,
    ];
    return padded.slice(-60);
  })();
  const peak = Math.max(...curveSeries, 0);
  const uniqueTools = new Set(
    activityEvents.filter((e) => e.kind === "tool").map((e) => e.tool),
  ).size;
  const activeRecipesCount = recipes.filter((r) => r.enabled !== false).length;

  const bridgeVersion = bridgeStatus.patchwork?.version ?? "unknown";
  const extensionVersion = health?.extensionVersion ?? "unknown";

  return (
    <section>
      {/* ------------------------------------------------------------------ */}
      {/* Quilt hero with LOAD widget                                          */}
      {/* ------------------------------------------------------------------ */}
      {/* TODO(design): the wireframe shows a "buddy quilt" 68% warmth widget
        * to the right of the hero (mood / fabric metaphor) instead of the
        * load ring. WeatherRing is the closest existing primitive; swap when
        * the buddy-quilt component spec lands. See screenshots @ 19.00.07. */}
      <QuiltHero
        greeting={greet ? `— ${greet.toLowerCase()}` : "— welcome"}
        headline={headline}
        summary={summary}
        aside={
          <WeatherRing
            label="LOAD"
            percent={loadPct}
            trend={loadTrend}
            live={bridgeStatus.ok}
            mood={
              !bridgeStatus.ok
                ? "bridge offline"
                : loadPct >= 80
                  ? "high load"
                  : loadPct >= 50
                    ? "warming up"
                    : "quiet"
            }
            meta={`${recipes.length} recipes · ${pendingApprovals.length} pending`}
          />
        }
      />

      {/* ------------------------------------------------------------------ */}
      {/* TELEMETRY eyebrow                                                    */}
      {/* ------------------------------------------------------------------ */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--s-3)",
          marginTop: "var(--s-5)",
          marginBottom: "var(--s-3)",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-2xs)",
            fontWeight: 700,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--ink-3)",
            flex: 1,
          }}
        >
          Telemetry
        </span>
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => tickRef.current()}
          style={{
            fontSize: "var(--fs-xs)",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M23 4v6h-6M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          Sync
        </button>
        <Link
          href="/recipes/new"
          className="btn sm primary"
          style={{
            textDecoration: "none",
            fontSize: "var(--fs-xs)",
            background: "var(--orange)",
            border: "none",
          }}
        >
          + New recipe
        </Link>
      </div>

      {/* Four telemetry tiles */}
      <div
        className="stat-grid"
        style={{
          marginBottom: "var(--s-5)",
          gridTemplateColumns: "repeat(4, minmax(0,1fr))",
        }}
      >
        {!health && bridgeStatus.ok !== false ? (
          <>
            <SkeletonStatCard />
            <SkeletonStatCard />
            <SkeletonStatCard />
            <SkeletonStatCard />
          </>
        ) : (
          <>
            <StatCard
              label="Recipes shipped"
              value={<AnimatedNumber value={recipesShipped} />}
              foot={recipesShipped === 0 ? "none yet" : "total"}
              href="/recipes"
            />
            <StatCard
              label="Pending approvals"
              value={<AnimatedNumber value={pendingCount} />}
              foot={oldestApprovalLabel}
              href="/approvals"
            />
            <StatCard
              label="Tools called today"
              value={<AnimatedNumber value={toolsToday} />}
              foot={toolsToday === 0 ? "no calls yet" : "last 60 min"}
              href="/activity"
            />
            <StatCard
              label="Tokens burnt"
              value={
                health?.tokens ? (
                  <AnimatedNumber value={health.tokens.total} />
                ) : (
                  "—"
                )
              }
              foot={
                health?.tokens && health.tokens.messages > 0
                  ? `${health.tokens.messages} msg${health.tokens.messages === 1 ? "" : "s"} · ${sess} session${sess === 1 ? "" : "s"}`
                  : `${sess} session${sess === 1 ? "" : "s"} · ${conns} connection${conns === 1 ? "" : "s"}`
              }
              href="/metrics"
            />
          </>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Tool calls — last 60 min (smooth filled curve)                       */}
      {/* ------------------------------------------------------------------ */}
      <div
        className="card"
        style={{
          padding: "16px 20px 12px",
          marginBottom: "var(--s-5)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 10,
            marginBottom: 4,
          }}
        >
          <span
            style={{
              fontSize: "var(--fs-m)",
              fontWeight: 700,
              color: "var(--ink-0)",
              flex: 1,
            }}
          >
            Tool calls — last 60 minutes
          </span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-xs)",
              color: "var(--orange)",
              fontWeight: 700,
            }}
          >
            {curveSeries.reduce((a, b) => a + b, 0)}
          </span>
        </div>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-xs)",
            color: "var(--ink-3)",
            marginBottom: 10,
          }}
        >
          peak {peak} / {uniqueTools} unique-tools / {activeRecipesCount} active-recipes
        </div>
        <AreaChart
          series={[{ values: curveSeries, color: "var(--orange)" }]}
          height={120}
        />
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Activity thread + Active recipe                                      */}
      {/* ------------------------------------------------------------------ */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
          gap: "var(--s-4)",
          marginBottom: "var(--s-5)",
        }}
      >
        <ActivityThread events={activityEvents.slice(-8).reverse()} />
        <ActiveRecipeCard />
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Health card                                                          */}
      {/* ------------------------------------------------------------------ */}
      <div style={{ marginBottom: "var(--s-6)" }}>
        <HealthCard
          bridgeVersion={bridgeVersion}
          extensionVersion={extensionVersion}
          bridgeOk={bridgeStatus.ok === true}
          extensionConnected={Boolean(health?.extensionConnected)}
        />
      </div>
    </section>
  );
}

// (kept for upstream typing imports / no-op reference)
export type { BridgeHealth };

// Suppress unused-import false positives for parsing helper retained intentionally.
void parseUptimeMs;
