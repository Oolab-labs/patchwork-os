"use client";

/**
 * What the information boundary actually decided (ADR-0021).
 *
 * The receipt ledger was write-only in the open runtime: every enforcement
 * decision was recorded and nothing in this repository could show it to the
 * operator. This page is the MIT-side reader — ADR-0019:88-92 requires the
 * local ledgers stay usable standalone, and ADR-0021:404-406 gives the reason:
 * being able to read the code that decides whether your data leaves the machine
 * is worth little if you cannot read what it decided.
 *
 * Two rules this page must keep, both inherited from `privacy shadow`:
 *   1. Lead with the DENOMINATOR. "3 refusals" invites the reading that
 *      everything else was fine.
 *   2. State its own COVERAGE. An empty ledger means the boundary has not run
 *      — commonly because no destination is registered — and must never render
 *      as a clean bill of health.
 */

import { useMemo } from "react";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";
import { EmptyState, ErrorState } from "@/components/patchwork";
import { relTime } from "@/components/time";
import { isRecord } from "@/lib/validate";

interface ReceiptView {
  seq?: number;
  at: number;
  decision: string;
  classification: string;
  categories?: string[];
  destinationId: string;
  destinationType?: "local" | "remote";
  redactCategories?: string[];
  reason: string;
  recipeName?: string;
  workspaceId?: string;
}

interface ReceiptsSummary {
  recorded: number;
  refusals: number;
  byDecision: Record<string, number>;
  byDestination: Record<string, number>;
  byClassification: Record<string, number>;
  refusalsByRecipe: Record<string, number>;
  refusalsUnattributed: number;
  earliest?: number;
  latest?: number;
  since?: number;
  unreadableLines: number;
  truncated: boolean;
  recent: ReceiptView[];
}

/** Only ALLOW is a plain pass. Everything else changed what happened. */
const DECISION_BLURB: Record<string, string> = {
  ALLOW: "sent as declared",
  ALLOW_REDACTED: "refused — redaction needs field-level labels (ADR-0021)",
  LOCAL_ONLY: "rerouted to a local model",
  REQUIRE_APPROVAL: "held for a human",
  DENY: "refused outright",
};

function toSummary(raw: unknown): ReceiptsSummary | null {
  if (!isRecord(raw) || typeof raw.recorded !== "number") return null;
  return raw as unknown as ReceiptsSummary;
}

function Rows({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return <p className="pill muted">none</p>;
  return (
    <ul className="privacy-rows">
      {entries.map(([k, v]) => (
        <li key={k}>
          <span>{k}</span>
          <strong>{v}</strong>
        </li>
      ))}
    </ul>
  );
}

export default function PrivacyPage() {
  const { data, error, loading, refetch } = useBridgeFetch<ReceiptsSummary | null>(
    "/api/bridge/privacy/receipts",
    { intervalMs: 15_000, transform: toSummary },
  );

  const fixList = useMemo(() => {
    if (!data) return [];
    const rows = Object.entries(data.refusalsByRecipe).sort((a, b) => b[1] - a[1]);
    if (data.refusalsUnattributed > 0) {
      rows.push(["(no recipe recorded)", data.refusalsUnattributed]);
    }
    return rows;
  }, [data]);

  return (
    <main className="page">
      <header className="page-head">
        <h1 className="editorial-h1">Information boundary</h1>
        <p className="editorial-sub">
          What this workspace’s live privacy policy actually decided — not what a
          candidate policy would have done. Every decision below was enforced.
        </p>
      </header>

      {error && (
        <ErrorState
          title="Could not read the receipt ledger"
          description="The bridge did not answer. This is a reachability failure, not a statement that nothing was decided."
          error={error}
          onRetry={refetch}
        />
      )}

      {!error && loading && !data && <p className="pill muted">Reading the ledger…</p>}

      {!error && data && data.recorded === 0 && (
        <EmptyState
          title="Nothing recorded"
          description={
            <>
              The boundary has written no receipt in this workspace. That means no
              agent step has dispatched since it was enabled, or no destination is
              registered under <code>privacy.destinations</code> — the boundary is
              inert until one is.
              <br />
              <strong>It does not mean nothing was refused.</strong>
            </>
          }
        />
      )}

      {!error && data && data.recorded > 0 && (
        <>
          {/* The denominator, first and largest. */}
          <section className="privacy-headline">
            <p className="privacy-figure">
              <strong>{data.recorded}</strong> boundary decisions recorded
            </p>
            <p className="editorial-sub">
              <strong>{data.refusals}</strong> of {data.recorded} were refused,
              rerouted or held for approval.
            </p>
            {data.earliest !== undefined && data.latest !== undefined && (
              <p className="pill muted">
                {relTime(data.earliest)} → {relTime(data.latest)}
              </p>
            )}
          </section>

          <section className="grid-2">
            <div>
              <h2>By decision</h2>
              <Rows counts={data.byDecision} />
              <ul className="privacy-legend">
                {Object.keys(data.byDecision).map((d) => (
                  <li key={d}>
                    <span className="tag-pill">{d}</span> {DECISION_BLURB[d] ?? "—"}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h2>By destination</h2>
              <Rows counts={data.byDestination} />
              <h2>By declared classification</h2>
              <Rows counts={data.byClassification} />
            </div>
          </section>

          {fixList.length > 0 && (
            <section>
              <h2>Refusals by recipe — the fix list</h2>
              <p className="editorial-sub">
                The remedy for a refusal is usually to fix the step that produced
                it. Rows with no recipe predate attribution.
              </p>
              <ul className="privacy-rows">
                {fixList.map(([name, n]) => (
                  <li key={name}>
                    <span>{name}</span>
                    <strong>{n}</strong>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h2>Most recent</h2>
            <ul className="privacy-receipts">
              {data.recent.map((r) => (
                <li key={`${r.seq ?? r.at}-${r.at}`}>
                  <span className="tag-pill">{r.decision}</span>{" "}
                  <span className="accent">{r.classification}</span> →{" "}
                  {r.destinationId}
                  {r.destinationType ? ` (${r.destinationType})` : ""}
                  {r.recipeName ? ` · ${r.recipeName}` : ""}
                  <span className="pill muted"> {relTime(r.at)}</span>
                  {r.reason && <div className="editorial-sub">{r.reason}</div>}
                </li>
              ))}
            </ul>
          </section>

          {/* Coverage is part of the finding, never a footnote under it. */}
          <section className="privacy-coverage">
            <h2>What this does and does not cover</h2>
            <ul>
              <li>
                Covers recipe agent steps, where a <code>data_policy</code> can be
                declared and a destination resolved.
              </li>
              <li>
                Does <strong>not</strong> cover orchestrator dispatches
                (<code>runClaudeTask</code>, automation hooks, recipe generation
                and repair). Those reach a model without a boundary decision,
                because there is no declared-policy channel on that path.
              </li>
              <li>
                Coverage here is <em>enumerated</em> from known dispatch paths. It
                is not proof that no other path exists.
              </li>
              <li>
                This ledger has no field for the prompt, deliberately — you can see
                what was declared and what was decided, never the content.
              </li>
              {data.unreadableLines > 0 && (
                <li>
                  {data.unreadableLines} line(s) in the ledger could not be parsed
                  and are excluded from every count above.
                </li>
              )}
              {data.truncated && (
                <li>
                  <strong>Truncated</strong> — a row limit cut this short, so the
                  counts are a floor.
                </li>
              )}
            </ul>
          </section>
        </>
      )}
    </main>
  );
}
