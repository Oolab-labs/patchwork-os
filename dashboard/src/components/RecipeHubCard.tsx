"use client";
import Link from "next/link";
import { canonicalRecipeKey } from "@/lib/entityKey";

interface Recipe {
  name: string;
  trigger?: string;
  description?: string;
  enabled?: boolean;
}

interface RunRecord {
  startedAt: number;
  status: string;
}

const STATUS_COLOR: Record<string, string> = {
  ok: "var(--ok)",
  done: "var(--ok)",
  success: "var(--ok)",
  error: "var(--err)",
  failed: "var(--err)",
  halted: "var(--warn)",
  running: "var(--accent-cool)",
  pending: "var(--ink-3)",
};

function statusColor(s: string | undefined): string {
  return STATUS_COLOR[s?.toLowerCase() ?? ""] ?? "var(--ink-3)";
}

function statusLabel(s: string | undefined): string {
  if (!s) return "never run";
  const m: Record<string, string> = {
    ok: "ok", done: "ok", success: "ok",
    error: "error", failed: "error",
    halted: "halted", running: "running", pending: "pending",
  };
  return m[s.toLowerCase()] ?? s;
}

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// Inline SVG trigger icons — 12×12
function TriggerIcon({ trigger }: { trigger: string | undefined }) {
  const t = (trigger ?? "manual").toLowerCase();
  if (t === "cron" || t === "schedule" || t === "scheduled") {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2" />
        <path d="M6 3v3l2 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }
  if (t === "file_watch" || t === "on_file_save" || t === "fs_watch") {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M2 2h5l2 2v6H2V2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        <path d="M7 2v2h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }
  if (t === "webhook" || t === "http") {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M3 6h6M7 4l2 2-2 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  // manual / default
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M5 2v4.5l-1.5-1L3 7l2.5 3L8 7l-1-.5L5.5 7.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function triggerLabel(trigger: string | undefined): string {
  const t = (trigger ?? "manual").toLowerCase();
  if (t === "cron" || t === "schedule" || t === "scheduled") return "scheduled";
  if (t === "file_watch" || t === "on_file_save" || t === "fs_watch") return "file watch";
  if (t === "webhook" || t === "http") return "webhook";
  return "manual";
}

export function RecipeHubCard({
  recipe,
  latestRun,
  totalRuns,
  isRunning,
}: {
  recipe: Recipe;
  latestRun: RunRecord | undefined;
  totalRuns: number;
  isRunning?: boolean;
}) {
  const href = `/recipes/${encodeURIComponent(canonicalRecipeKey(recipe.name))}`;
  const status = isRunning ? "running" : latestRun?.status;
  const enabled = recipe.enabled !== false;

  return (
    <div
      className="recipe-hub-card"
      data-disabled={!enabled || undefined}
      style={{
        background: "var(--bg-1, var(--surface))",
        border: "1px solid var(--line-2)",
        borderRadius: 14,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        minHeight: 140,
        position: "relative",
        opacity: enabled ? 1 : 0.55,
        transition: "border-color 150ms, box-shadow 150ms",
        cursor: "pointer",
      }}
    >
      {/* top row: name + status pill */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <Link
          href={href}
          style={{
            fontSize: "var(--fs-xl)",
            fontWeight: 600,
            color: "var(--ink-1)",
            textDecoration: "none",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            minWidth: 0,
          }}
          title={recipe.name}
          tabIndex={0}
        >
          {recipe.name}
        </Link>
        {status && (
          <span
            style={{
              fontSize: "var(--fs-xs)",
              fontWeight: 600,
              padding: "2px 7px",
              borderRadius: 999,
              flexShrink: 0,
              background: `color-mix(in srgb, ${statusColor(status)} 15%, var(--bg-1, var(--surface)))`,
              color: statusColor(status),
              border: `1px solid color-mix(in srgb, ${statusColor(status)} 35%, transparent)`,
            }}
          >
            {statusLabel(status)}
          </span>
        )}
      </div>

      {/* trigger row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          fontSize: "var(--fs-s)",
          fontWeight: 500,
          color: "var(--ink-2)",
        }}
      >
        <TriggerIcon trigger={recipe.trigger} />
        {triggerLabel(recipe.trigger)}
      </div>

      {/* run meta */}
      <div style={{ fontSize: "var(--fs-s)", fontWeight: 400, color: "var(--ink-3)", flex: 1 }}>
        {totalRuns > 0
          ? `${totalRuns} run${totalRuns === 1 ? "" : "s"} · last ${latestRun ? relTime(latestRun.startedAt) : "—"}`
          : "no runs yet"}
      </div>

      {/* footer: open button */}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
        <Link
          href={href}
          className="btn ghost"
          style={{
            height: 32,
            padding: "0 12px",
            borderRadius: 10,
            fontSize: "var(--fs-m)",
            fontWeight: 500,
            textDecoration: "none",
          }}
          tabIndex={-1}
          aria-hidden="true"
        >
          Open →
        </Link>
      </div>
    </div>
  );
}
