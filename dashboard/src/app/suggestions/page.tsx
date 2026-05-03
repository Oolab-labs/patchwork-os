"use client";
import Link from "next/link";
import { useState } from "react";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";

interface CoOccurringPairDetails {
  pair: [string, string];
  count: number;
}
interface InstalledButUnusedDetails {
  unusedCount: number;
  examples: string[];
}
interface RecipeTrustGraduationDetails {
  recipeName: string;
  runs: number;
}

interface AutomationSuggestion {
  kind:
    | "co_occurring_pair"
    | "installed_but_unused"
    | "recipe_trust_graduation";
  label: string;
  details?:
    | CoOccurringPairDetails
    | InstalledButUnusedDetails
    | RecipeTrustGraduationDetails
    | undefined;
}

interface SuggestionsResponse {
  suggestions: AutomationSuggestion[];
  generatedAt: string;
}

const KIND_META: Record<
  AutomationSuggestion["kind"],
  { label: string; pillClass: string; explanation: string }
> = {
  co_occurring_pair: {
    label: "Pair to recipe",
    pillClass: "warn",
    explanation:
      "Two tools you've called together repeatedly that don't yet appear in any installed recipe.",
  },
  installed_but_unused: {
    label: "Unused tool",
    pillClass: "muted",
    explanation:
      "Tools registered with the bridge but never called in the lookback window.",
  },
  recipe_trust_graduation: {
    label: "Trust candidate",
    pillClass: "ok",
    explanation:
      "Recipes that have succeeded enough times that you might want to auto-approve them.",
  },
};

function isCoOccurringPair(
  d: AutomationSuggestion["details"],
): d is CoOccurringPairDetails {
  return !!d && Array.isArray((d as CoOccurringPairDetails).pair);
}
function isUnusedDetails(
  d: AutomationSuggestion["details"],
): d is InstalledButUnusedDetails {
  return !!d && typeof (d as InstalledButUnusedDetails).unusedCount === "number";
}
function isTrustDetails(
  d: AutomationSuggestion["details"],
): d is RecipeTrustGraduationDetails {
  return !!d && typeof (d as RecipeTrustGraduationDetails).recipeName === "string";
}

export default function SuggestionsPage() {
  const [sinceDays, setSinceDays] = useState(7);
  const { data, error, loading } = useBridgeFetch<SuggestionsResponse>(
    `/api/bridge/suggestions?sinceDays=${sinceDays}`,
    { intervalMs: 30000 },
  );
  const suggestions = data?.suggestions ?? [];

  // Group by kind so each section can have its own framing.
  const byKind = {
    co_occurring_pair: suggestions.filter((s) => s.kind === "co_occurring_pair"),
    recipe_trust_graduation: suggestions.filter(
      (s) => s.kind === "recipe_trust_graduation",
    ),
    installed_but_unused: suggestions.filter(
      (s) => s.kind === "installed_but_unused",
    ),
  } as const;

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Suggestions</h1>
          <div className="page-head-sub">
            Pattern-mined from your activity log + recipe runs. Read-only —
            nothing on this page changes policy or installs anything. Same data
            the <code>patchwork suggest</code> CLI prints.
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <label htmlFor="since-days" style={{ fontSize: 12, color: "var(--fg-2)" }}>
            Lookback
          </label>
          <select
            id="since-days"
            value={sinceDays}
            onChange={(e) => setSinceDays(Number.parseInt(e.target.value, 10))}
            style={{
              background: "var(--bg-2)",
              border: "1px solid var(--border-default)",
              borderRadius: "var(--r-2)",
              color: "var(--fg-0)",
              fontSize: 12,
              padding: "4px 8px",
              outline: "none",
            }}
          >
            <option value={1}>1 day</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
          <span className="pill muted">
            {suggestions.length} {suggestions.length === 1 ? "hint" : "hints"}
          </span>
        </div>
      </div>

      {loading && suggestions.length === 0 && (
        <p style={{ color: "var(--fg-2)" }}>Loading…</p>
      )}
      {error && <div className="alert-err">Unreachable: {error}</div>}

      {!loading && !error && suggestions.length === 0 && (
        <div className="empty-state">
          <h3>No suggestions right now</h3>
          <p>
            Either the lookback window is too short, your activity log doesn't
            have enough variety yet, or every co-occurring pair is already in a
            recipe. Try widening the lookback above, or come back after a few
            more days of normal use.
          </p>
        </div>
      )}

      {byKind.co_occurring_pair.length > 0 && (
        <SuggestionGroup
          title="Tool pairs that aren't in any recipe yet"
          subtitle={KIND_META.co_occurring_pair.explanation}
          items={byKind.co_occurring_pair}
          renderAction={(s) => {
            if (!isCoOccurringPair(s.details)) return null;
            const [a, b] = s.details.pair;
            return (
              <Link
                href={`/recipes/new?vars=${encodeURIComponent(`${a},${b}`)}`}
                className="btn sm"
                style={{ textDecoration: "none" }}
              >
                Draft a recipe
              </Link>
            );
          }}
        />
      )}

      {byKind.recipe_trust_graduation.length > 0 && (
        <SuggestionGroup
          title="Recipes worth trust-graduating"
          subtitle={KIND_META.recipe_trust_graduation.explanation}
          items={byKind.recipe_trust_graduation}
          renderAction={(s) => {
            if (!isTrustDetails(s.details)) return null;
            return (
              <Link
                href={`/recipes`}
                className="btn sm ghost"
                style={{ textDecoration: "none" }}
              >
                Open {s.details.recipeName} →
              </Link>
            );
          }}
        />
      )}

      {byKind.installed_but_unused.length > 0 && (
        <SuggestionGroup
          title="Installed tools you haven't called recently"
          subtitle={KIND_META.installed_but_unused.explanation}
          items={byKind.installed_but_unused}
          renderAction={() => null}
        />
      )}

      {data?.generatedAt && (
        <p
          style={{
            fontSize: 11,
            color: "var(--fg-2)",
            marginTop: "var(--s-5)",
          }}
        >
          Generated at {new Date(data.generatedAt).toLocaleTimeString()}.
        </p>
      )}
    </section>
  );
}

function SuggestionGroup({
  title,
  subtitle,
  items,
  renderAction,
}: {
  title: string;
  subtitle: string;
  items: AutomationSuggestion[];
  renderAction: (s: AutomationSuggestion) => React.ReactNode;
}) {
  return (
    <div className="card" style={{ marginTop: "var(--s-4)" }}>
      <div className="card-head">
        <h2>{title}</h2>
        <span className="pill muted">{items.length}</span>
      </div>
      <p style={{ fontSize: 12, color: "var(--fg-2)", margin: "0 0 var(--s-3)" }}>
        {subtitle}
      </p>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {items.map((s, idx) => {
          const meta = KIND_META[s.kind];
          const key = `${s.kind}-${idx}-${
            isCoOccurringPair(s.details)
              ? s.details.pair.join("|")
              : isTrustDetails(s.details)
                ? s.details.recipeName
                : isUnusedDetails(s.details)
                  ? `unused-${s.details.unusedCount}`
                  : "anon"
          }`;
          const action = renderAction(s);
          return (
            <li
              key={key}
              style={{
                display: "flex",
                gap: 12,
                alignItems: "center",
                padding: "10px 0",
                borderBottom: "1px solid var(--border-subtle)",
              }}
            >
              <span className={`pill ${meta.pillClass}`} style={{ fontSize: 10 }}>
                {meta.label}
              </span>
              <span style={{ flex: 1, fontSize: 13 }}>{s.label}</span>
              {action}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
