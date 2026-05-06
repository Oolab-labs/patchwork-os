"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiPath } from "@/lib/api";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";
import { DecisionsTabs } from "@/components/DecisionsTabs";
import { ErrorState } from "@/components/patchwork";

const SINCE_DAYS_OPTIONS = [1, 7, 30, 90] as const;
type SinceDays = (typeof SINCE_DAYS_OPTIONS)[number];
function parseSinceDays(v: string | null): SinceDays {
  const n = v ? Number(v) : NaN;
  return SINCE_DAYS_OPTIONS.includes(n as SinceDays) ? (n as SinceDays) : 7;
}

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

function GraduateButton({ recipeName }: { recipeName: string }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">(
    "idle",
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  async function graduate() {
    setState("loading");
    setErrorMsg(null);
    try {
      const res = await fetch(
        apiPath(`/api/bridge/recipes/${encodeURIComponent(recipeName)}/trust`),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ level: "mostly_trusted" }),
        },
      );
      if (res.ok) {
        setState("done");
      } else {
        const text = await res.text().catch(() => res.statusText);
        setErrorMsg(`${res.status}${text ? ` — ${text.slice(0, 120)}` : ""}`);
        setState("error");
      }
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }
  if (state === "done") {
    return (
      <span style={{ color: "var(--ok)", fontSize: "var(--fs-m)" }} role="status">
        <span aria-hidden="true">✓ </span>Graduated to mostly trusted
      </span>
    );
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <button
        type="button"
        className="btn sm"
        disabled={state === "loading"}
        aria-busy={state === "loading"}
        aria-label={`Graduate trust for ${recipeName}`}
        onClick={() => void graduate()}
      >
        {state === "loading"
          ? "Graduating…"
          : state === "error"
            ? "Retry"
            : "Graduate trust"}
      </button>
      {state === "error" && errorMsg && (
        <span role="alert" style={{ fontSize: "var(--fs-s)", color: "var(--err)" }}>
          {errorMsg}
        </span>
      )}
    </span>
  );
}

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
  const router = useRouter();
  const searchParams = useSearchParams();
  const [sinceDays, setSinceDaysState] = useState<SinceDays>(() => parseSinceDays(searchParams?.get("since")));
  const setSinceDays = (next: SinceDays) => {
    setSinceDaysState(next);
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (next === 7) params.delete("since");
    else params.set("since", String(next));
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  };
  const { data, error, loading, refetch } = useBridgeFetch<SuggestionsResponse>(
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
      <DecisionsTabs />
      <div className="page-head">
        <div>
          <h1 className="editorial-h1">
            Suggestions — <span className="accent">patterns mined from your runs.</span>
          </h1>
          <div className="editorial-sub" style={{ fontFamily: "inherit" }}>
            Read-only — nothing on this page changes policy. Same data <code>patchwork suggest</code> prints.
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <label htmlFor="since-days" style={{ fontSize: "var(--fs-s)", color: "var(--fg-2)" }}>
            Lookback
          </label>
          <select
            id="since-days"
            value={sinceDays}
            onChange={(e) => setSinceDays(parseSinceDays(e.target.value))}
            style={{
              background: "var(--bg-2)",
              border: "1px solid var(--border-default)",
              borderRadius: "var(--r-2)",
              color: "var(--fg-0)",
              fontSize: "var(--fs-s)",
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
      {error && suggestions.length === 0 && (
        <ErrorState
          title="Couldn't load suggestions"
          description="The bridge isn't responding to /suggestions."
          error={error}
          onRetry={refetch}
        />
      )}
      {error && suggestions.length > 0 && (
        <div className="alert-err">Refresh failed — {error}</div>
      )}

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
            const { recipeName } = s.details;
            return (
              <GraduateButton recipeName={recipeName} />
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
            fontSize: "var(--fs-xs)",
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

const SUGGESTION_PAGE_SIZE = 20;

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
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? items : items.slice(0, SUGGESTION_PAGE_SIZE);
  const hidden = items.length - visible.length;
  return (
    <div className="card" style={{ marginTop: "var(--s-4)" }}>
      <div className="card-head">
        <h2>{title}</h2>
        <span className="pill muted">{items.length}</span>
      </div>
      <p style={{ fontSize: "var(--fs-s)", color: "var(--fg-2)", margin: "0 0 var(--s-3)" }}>
        {subtitle}
      </p>
      <ul role="list" aria-label={title} style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {visible.map((s, idx) => {
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
              <span className={`pill ${meta.pillClass}`} style={{ fontSize: "var(--fs-2xs)" }}>
                {meta.label}
              </span>
              <span style={{ flex: 1, fontSize: "var(--fs-m)" }}>{s.label}</span>
              {action}
            </li>
          );
        })}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => setShowAll(true)}
          style={{ marginTop: "var(--s-3)", fontSize: "var(--fs-s)" }}
        >
          Show {hidden} more
        </button>
      )}
    </div>
  );
}
