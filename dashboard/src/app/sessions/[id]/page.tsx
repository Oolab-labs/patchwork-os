"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import dynamic from "next/dynamic";
import { relTime } from "@/components/time";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";
import { arr, isRecord, shape, type ShapeCheck } from "@/lib/validate";

const MessageMarkdown = dynamic(() => import("@/components/MessageMarkdown"), {
  ssr: false,
  loading: () => null,
});

// Inline markdown for the narrow "Detail" column: keeps paragraphs flush
// (no top/bottom margins), styles inline code as a soft pill, and lets
// long unbroken tokens (paths, hashes) wrap instead of overflowing.
const detailMarkdownComponents = {
  p: ({ children }: { children?: React.ReactNode }) => (
    <span
      style={{
        display: "inline",
        overflowWrap: "break-word",
        wordBreak: "break-word",
      }}
    >
      {children}
    </span>
  ),
  code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
    const isBlock = !!className;
    return isBlock ? (
      <code style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)" }}>{children}</code>
    ) : (
      <code
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.875em",
          background: "var(--recess)",
          border: "1px solid var(--line-1)",
          borderRadius: 4,
          padding: "1px 5px",
          wordBreak: "break-all",
        }}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }: { children?: React.ReactNode }) => (
    <pre
      style={{
        background: "var(--recess)",
        border: "1px solid var(--line-2)",
        borderRadius: "var(--r-s)",
        padding: "8px 10px",
        margin: "4px 0 0",
        fontSize: "var(--fs-xs)",
        fontFamily: "var(--font-mono)",
        lineHeight: 1.55,
        overflowX: "auto",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
      }}
    >
      {children}
    </pre>
  ),
  a: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
    <a href={href} style={{ color: "var(--accent)" }} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong style={{ color: "var(--fg-0)" }}>{children}</strong>
  ),
};

interface SessionSummary {
  id: string;
  connectedAt: string;
  openedFileCount: number;
  pendingApprovals: number;
}

interface LifecycleEntry {
  id: number;
  timestamp: string;
  event: string;
  metadata?: Record<string, unknown>;
}

interface ToolEntry {
  id: number;
  timestamp: string;
  tool: string;
  durationMs: number;
  status: "success" | "error";
  errorMessage?: string;
}

type StreamRow =
  | { kind: "lifecycle"; entry: LifecycleEntry }
  | { kind: "tool"; entry: ToolEntry };

interface PendingApproval {
  callId: string;
  toolName: string;
  tier: "low" | "medium" | "high";
  requestedAt: number;
  summary?: string;
}

interface DecisionEntry {
  seq: number;
  createdAt: number;
  ref: string;
  problem: string;
  solution: string;
  tags?: string[];
}

interface DetailResponse {
  summary: SessionSummary | null;
  lifecycle: LifecycleEntry[];
  tools?: ToolEntry[];
  decisions?: DecisionEntry[];
  approvals: PendingApproval[];
}

/**
 * Minimal runtime validation — catches bridge/dashboard version drift
 * (e.g. an older bridge that predates tools[] / decisions[]) and turns
 * silent blank sections into a loud error. Intentionally permissive on
 * optional arrays: missing is fine (older bridge), wrong type is not.
 */
const validateDetail: ShapeCheck<DetailResponse> = shape(
  "/sessions/:id",
  (raw, errors) => {
    if (!isRecord(raw)) {
      errors.push({ path: "$", reason: "expected object" });
      return null;
    }
    // summary may be null (unknown session) — only fail on unexpected shapes.
    if (raw.summary !== null && !isRecord(raw.summary)) {
      errors.push({ path: "summary", reason: "expected object or null" });
    }
    arr(raw, "lifecycle", errors);
    arr(raw, "approvals", errors);
    arr(raw, "tools", errors, { optional: true });
    arr(raw, "decisions", errors, { optional: true });
    if (errors.length > 0) return null;
    return raw as unknown as DetailResponse;
  },
);

const NOISE_EVENTS = new Set([
  "claude_connected",
  "claude_disconnected",
  "extension_connected",
  "extension_disconnected",
  "grace_started",
  "grace_expired",
]);

export default function SessionDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const { data, error, loading, status } = useBridgeFetch<DetailResponse>(
    `/api/bridge/sessions/${id}`,
    { intervalMs: 3000, transform: validateDetail },
  );

  const summary = data?.summary ?? null;
  const approvals = data?.approvals ?? [];
  const lifecycle = data?.lifecycle ?? [];
  const tools = data?.tools ?? [];
  const decisions = data?.decisions ?? [];
  // Lifecycle and tool entries come from independent auto-increment
  // counters server-side, so sorting by `entry.id` interleaves the two
  // streams arbitrarily (lifecycle row 5 is not the same instant as tool
  // row 5). Use the wall-clock timestamp instead so the merged stream
  // reflects actual chronology.
  const stream: StreamRow[] = [
    ...lifecycle.map((entry) => ({ kind: "lifecycle" as const, entry })),
    ...tools.map((entry) => ({ kind: "tool" as const, entry })),
  ]
    .sort((a, b) => Date.parse(b.entry.timestamp) - Date.parse(a.entry.timestamp));

  return (
    <section>
      <div className="page-head">
        <div>
          <div style={{ fontSize: "var(--fs-s)", marginBottom: 4 }}>
            <Link href="/sessions" style={{ color: "var(--fg-2)" }}>
              ← Sessions
            </Link>
          </div>
          <h1>
            <code style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-3xl)" }}>
              {id.slice(0, 8)}
            </code>
          </h1>
          <div
            className="page-head-sub"
            title={id}
            style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-s)" }}
          >
            {id}
          </div>
        </div>
        {summary && (
          <div style={{ display: "flex", gap: 6 }}>
            <span className="pill muted">
              {summary.openedFileCount} open
            </span>
            {summary.pendingApprovals > 0 && (
              <Link
                href={`/approvals?session=${id}`}
                className="pill err"
                title="Pending approvals"
              >
                {summary.pendingApprovals} pending
              </Link>
            )}
          </div>
        )}
      </div>

      {error && !data && (
        <div className="alert-err">
          {error.startsWith("/sessions/:id")
            ? `Response shape unexpected (bridge version mismatch?): ${error}`
            : `Unreachable: ${error}`}
        </div>
      )}
      {loading && !data && !error && (
        <div className="empty-state" role="status" aria-live="polite">
          <p>Loading session…</p>
        </div>
      )}
      {!loading && !data && status === 404 && (
        <div className="empty-state">
          <h3>Session not found</h3>
          <p>
            No active session with this id. It may have disconnected, or the
            id is wrong.
          </p>
        </div>
      )}

      {summary && (
        <div
          className="card"
          style={{
            marginTop: "var(--s-4)",
            padding: "16px 20px",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: "var(--s-4)",
          }}
        >
          <div>
            <div
              style={{
                fontSize: "var(--fs-2xs)",
                color: "var(--ink-2)",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                marginBottom: 4,
              }}
            >
              Connected
            </div>
            <div
              style={{ fontSize: "var(--fs-m)", color: "var(--ink-0)", fontWeight: 500 }}
              title={new Date(summary.connectedAt).toLocaleString()}
            >
              {relTime(new Date(summary.connectedAt).getTime())}
            </div>
          </div>
          <div>
            <div
              style={{
                fontSize: "var(--fs-2xs)",
                color: "var(--ink-2)",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                marginBottom: 4,
              }}
            >
              Open files
            </div>
            <div
              style={{
                fontSize: "var(--fs-stat)",
                fontFamily: "var(--font-mono)",
                fontWeight: 700,
                color: "var(--ink-0)",
              }}
            >
              {summary.openedFileCount}
            </div>
          </div>
          <div>
            <div
              style={{
                fontSize: "var(--fs-2xs)",
                color: "var(--ink-2)",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                marginBottom: 4,
              }}
            >
              Pending approvals
            </div>
            <div
              style={{
                fontSize: "var(--fs-stat)",
                fontFamily: "var(--font-mono)",
                fontWeight: 700,
                color:
                  summary.pendingApprovals > 0
                    ? "var(--amber)"
                    : "var(--ink-0)",
              }}
            >
              {summary.pendingApprovals}
            </div>
          </div>
          <div>
            <div
              style={{
                fontSize: "var(--fs-2xs)",
                color: "var(--ink-2)",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                marginBottom: 4,
              }}
            >
              Events logged
            </div>
            <div
              style={{
                fontSize: "var(--fs-stat)",
                fontFamily: "var(--font-mono)",
                fontWeight: 700,
                color: "var(--ink-0)",
              }}
            >
              {stream.length}
            </div>
          </div>
        </div>
      )}

      {approvals.length > 0 && (
        <div className="card" style={{ marginTop: "var(--s-4)" }}>
          <div className="card-head">
            <h2>Pending approvals</h2>
            <span className="pill warn">{approvals.length}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {approvals.map((a) => (
              <Link
                key={a.callId}
                href={`/approvals/${a.callId}`}
                style={{
                  display: "flex",
                  gap: "var(--s-3)",
                  alignItems: "center",
                  padding: "8px 10px",
                  background: "var(--bg-0)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "var(--r-2)",
                  textDecoration: "none",
                  color: "inherit",
                }}
              >
                <span
                  className={`pill ${a.tier === "high" ? "err" : a.tier === "medium" ? "warn" : "ok"}`}
                >
                  {a.tier}
                </span>
                <span className="mono" style={{ fontSize: "var(--fs-m)" }}>
                  {a.toolName}
                </span>
                <span
                  style={{
                    flex: 1,
                    color: "var(--fg-2)",
                    fontSize: "var(--fs-m)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {a.summary ?? "—"}
                </span>
                <span style={{ color: "var(--fg-3)", fontSize: "var(--fs-s)" }}>
                  {relTime(a.requestedAt)}
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {decisions.length > 0 && (
        <div className="card" style={{ marginTop: "var(--s-4)" }}>
          <div className="card-head">
            <h2>Decisions saved</h2>
            <span className="pill muted">{decisions.length}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {decisions.map((d) => {
              const tags = Array.isArray(d.tags) ? d.tags.slice(0, 3) : [];
              return (
                <Link
                  key={d.seq}
                  href="/decisions"
                  style={{
                    display: "flex",
                    gap: "var(--s-3)",
                    alignItems: "baseline",
                    padding: "8px 10px",
                    background: "var(--bg-0)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "var(--r-2)",
                    textDecoration: "none",
                    color: "inherit",
                  }}
                >
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--fs-s)",
                      color: "var(--purple)",
                      flexShrink: 0,
                    }}
                  >
                    {d.ref}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      fontSize: "var(--fs-m)",
                      color: "var(--fg-1)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {d.solution}
                  </span>
                  {tags.length > 0 && (
                    <span
                      style={{
                        fontSize: "var(--fs-xs)",
                        fontFamily: "var(--font-mono)",
                        color: "var(--fg-3)",
                        flexShrink: 0,
                      }}
                    >
                      {tags.join(",")}
                    </span>
                  )}
                  <span
                    style={{
                      fontSize: "var(--fs-s)",
                      color: "var(--fg-3)",
                      flexShrink: 0,
                    }}
                  >
                    {relTime(d.createdAt)}
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {stream.length > 0 && (
        <div className="card" style={{ marginTop: "var(--s-4)" }}>
          <div className="card-head">
            <h2>Event stream</h2>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                fontSize: "var(--fs-xs)",
                color: "var(--green)",
                fontWeight: 600,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: "var(--green)",
                }}
              />
              live
            </span>
            <span className="pill muted">{stream.length}</span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 140 }}>Time</th>
                  <th style={{ width: 160 }}>Event</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {stream.map((row) => {
                  if (row.kind === "tool") {
                    const t = row.entry;
                    return (
                      <tr key={`t-${t.id}`}>
                        <td className="muted" title={t.timestamp}>
                          {relTime(Date.parse(t.timestamp))}
                        </td>
                        <td>
                          <span
                            className={`pill ${t.status === "success" ? "ok" : "err"}`}
                          >
                            {t.tool}
                          </span>
                        </td>
                        <td style={{ fontSize: "var(--fs-m)" }}>
                          {t.status === "error" && t.errorMessage ? (
                            <MessageMarkdown
                              content={t.errorMessage}
                              components={detailMarkdownComponents}
                            />
                          ) : (
                            `${t.durationMs}ms`
                          )}
                        </td>
                      </tr>
                    );
                  }
                  const e = row.entry;
                  const isNoise = NOISE_EVENTS.has(e.event);
                  const isApproval = e.event === "approval_decision";
                  const meta = e.metadata ?? {};
                  const detail = isApproval
                    ? `${meta.decision ?? "?"} ${meta.toolName ?? ""}${meta.reason ? ` — ${meta.reason}` : ""}`
                    : typeof meta.summary === "string"
                      ? meta.summary
                      : "—";
                  return (
                    <tr key={`l-${e.id}`}>
                      <td className="muted" title={e.timestamp}>
                        {relTime(Date.parse(e.timestamp))}
                      </td>
                      <td>
                        <span
                          className={`pill ${
                            isApproval
                              ? meta.decision === "allow"
                                ? "ok"
                                : "err"
                              : isNoise
                                ? "muted"
                                : "ok"
                          }`}
                        >
                          {e.event}
                        </span>
                      </td>
                      <td style={{ fontSize: "var(--fs-m)" }}>
                        {detail === "—" ? (
                          detail
                        ) : (
                          <MessageMarkdown
                            content={detail}
                            components={detailMarkdownComponents}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {summary &&
        stream.length === 0 &&
        approvals.length === 0 &&
        decisions.length === 0 && (
        <div className="empty-state" style={{ marginTop: "var(--s-4)" }}>
          <h3>No recorded activity</h3>
          <p>
            This session has connected but hasn&apos;t produced any lifecycle
            events or approvals yet.
          </p>
        </div>
      )}
    </section>
  );
}
