/**
 * Derive the recipe page's Band 1 status medallion + Band 2 "Needs you" rows
 * from facts the page already has. Pure and total so it can be unit-tested
 * without the bridge — the page just feeds it derived values.
 *
 * Answers the operator's first two questions in order: "Is it okay?" (the
 * medallion) and "What needs me?" (the needs rows). Engineer detail (raw
 * cron, halt categories, success %) stays on the page, folded under details.
 */

import type { HaltCategory } from "./haltCategory";
import { type HaltFixAction, ownerHaltPhrase } from "./haltPhrasing";
import type { MedallionTone } from "@/components/StatusMedallion";

export type LastOutcome = "ok" | "warn" | "err" | "running" | "other";

export interface RecipeStatusInput {
  enabled: boolean;
  /** "manual" | "cron" | "schedule" | "webhook" | … */
  trigger: string;
  hasRuns: boolean;
  lastOutcome?: LastOutcome;
  /** "2h ago" etc. */
  lastWhen?: string;
  lastDuration?: string;
  /** Plain schedule text from humanizeSchedule(). */
  scheduleText: string;
  /** "next in 14h" from describeNextRun(), or null. */
  nextRunPhrase?: string | null;
  /** Most recent halt category, when the last/recent run stopped. */
  recentHalt?: HaltCategory | null;
  /** Required connectors that are NOT currently connected (plain names). */
  disconnectedConnectors?: string[];
}

/** A fix action the page can wire; extends the halt fix actions with page-local ones. */
export type NeedFix = HaltFixAction | "resume" | "connect-page";

export interface NeedRow {
  key: string;
  sentence: string;
  fix?: { action: NeedFix; label: string };
}

export interface RecipeStatusView {
  medallion: { tone: MedallionTone; title: string; sentence: string };
  needs: NeedRow[];
}

const CONNECTOR_HALTS = new Set<HaltCategory>(["auth_failure", "missing_connector"]);

export function deriveRecipeStatus(input: RecipeStatusInput): RecipeStatusView {
  const disconnected = input.disconnectedConnectors ?? [];
  const svc = disconnected[0];

  // ── Medallion (first true wins) ─────────────────────────────────────────
  let medallion: RecipeStatusView["medallion"];
  if (!input.enabled) {
    medallion = {
      tone: "muted",
      title: "Paused",
      sentence: "It won't run until you resume it.",
    };
  } else if (input.lastOutcome === "running") {
    medallion = {
      tone: "ok",
      title: "Running now",
      sentence: "It's working on a run right now.",
    };
  } else if (input.recentHalt || input.lastOutcome === "err") {
    medallion = {
      tone: "err",
      title: "Stopped — needs attention",
      sentence: input.recentHalt
        ? ownerHaltPhrase(input.recentHalt, svc).sentence
        : "Its last run stopped before finishing.",
    };
  } else if (disconnected.length > 0) {
    medallion = {
      tone: "warn",
      title: "Needs a connection",
      sentence: `It can't run until ${svc} is reconnected.`,
    };
  } else if (input.lastOutcome === "warn") {
    medallion = {
      tone: "warn",
      title: "Finished with problems",
      sentence: "Its last run completed, but some steps had errors.",
    };
  } else if (!input.hasRuns) {
    medallion = {
      tone: "muted",
      title: "New — hasn't run yet",
      sentence: `Run it once to see what it does, or wait for its schedule (${input.scheduleText}).`,
    };
  } else {
    const ran =
      input.lastWhen && input.lastDuration
        ? `Ran ${input.lastWhen} in ${input.lastDuration}.`
        : input.lastWhen
          ? `Ran ${input.lastWhen}.`
          : "";
    const next = input.nextRunPhrase ? ` — ${input.nextRunPhrase}` : "";
    medallion = {
      tone: "ok",
      title: "Working fine",
      sentence: `${ran} ${input.scheduleText}${next}`.trim(),
    };
  }

  // ── Needs-you rows ──────────────────────────────────────────────────────
  // Deliberately NOT surfacing a "paused" row: the medallion already says
  // "Paused" and the action bar already offers Resume — a second Resume here
  // is pure redundancy.
  const needs: NeedRow[] = [];

  // Disconnected connectors — grouped so N problems that all lead to the same
  // Connections page read as one task, not a repetitive stack. A connector row
  // supersedes a redundant auth/missing halt row for the same cause.
  if (disconnected.length === 1) {
    needs.push({
      key: `connector:${disconnected[0]}`,
      sentence: `It needs ${disconnected[0]} connected before it can run.`,
      fix: { action: "connect-page", label: `Connect ${disconnected[0]}` },
    });
  } else if (disconnected.length > 1) {
    needs.push({
      key: "connectors",
      sentence: `It needs ${disconnected.length} connections set up before it can run: ${disconnected.join(", ")}.`,
      fix: { action: "connect-page", label: "Go to Connections" },
    });
  }

  if (input.recentHalt) {
    const covered = CONNECTOR_HALTS.has(input.recentHalt) && disconnected.length > 0;
    if (!covered) {
      const phrase = ownerHaltPhrase(input.recentHalt, svc);
      needs.push({
        key: `halt:${input.recentHalt}`,
        sentence: phrase.sentence,
        fix:
          phrase.fix === "none" || phrase.fix === "wait"
            ? undefined
            : { action: phrase.fix, label: phrase.fixLabel ?? "Fix" },
      });
    }
  }

  return { medallion, needs };
}
