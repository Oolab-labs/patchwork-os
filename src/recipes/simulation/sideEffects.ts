/**
 * What-If Preview — static side-effect classification.
 *
 * Classifies a single plan step into a {@link SideEffectKind} using ONLY
 * registry metadata already present on the dry-run plan step
 * (`type` / `tool` / `namespace` / `isWrite` / `isConnector` / `resolved`).
 * No execution, no network, no token resolution.
 */

import type { SideEffectKind } from "./types.js";

/** Namespaces whose writes are arbitrary outbound HTTP rather than a SaaS connector. */
const EXTERNAL_HTTP_NAMESPACES = new Set(["http", "webhook"]);

export interface SideEffectInput {
  type: "tool" | "agent" | "recipe";
  tool?: string;
  namespace?: string;
  resolved?: boolean;
  isWrite?: boolean;
  isConnector?: boolean;
}

/**
 * Map a plan step to its side-effect class. Pure and total.
 *
 * Precedence:
 *   agent → agent-llm; recipe → nested-recipe.
 *   unresolved tool → unknown (we cannot claim a side effect we can't see).
 *   http/webhook namespace → external-http (write or read).
 *   connector → connector-write / connector-read on isWrite.
 *   otherwise local-write / local-read on isWrite.
 */
export function classifyStepSideEffect(step: SideEffectInput): SideEffectKind {
  if (step.type === "agent") return "agent-llm";
  if (step.type === "recipe") return "nested-recipe";

  // type === "tool"
  if (step.resolved === false) return "unknown";

  const ns = step.namespace ?? step.tool?.split(".")[0];
  if (ns && EXTERNAL_HTTP_NAMESPACES.has(ns)) return "external-http";

  const isWrite = step.isWrite === true;
  if (step.isConnector === true) {
    return isWrite ? "connector-write" : "connector-read";
  }
  return isWrite ? "local-write" : "local-read";
}

/** Human-readable, one-line description of a side-effect class. */
export const SIDE_EFFECT_LABELS: Record<SideEffectKind, string> = {
  "local-read": "reads local/workspace state",
  "local-write": "writes local/workspace state",
  "connector-read": "reads an external connector",
  "connector-write": "writes to an external connector",
  "external-http": "makes an outbound HTTP/webhook call",
  "agent-llm": "runs an AI/agent step (not executed in simulation)",
  "nested-recipe": "delegates to a nested recipe",
  unknown: "unresolved tool — side effect unknown",
};

/** Empty side-effect tally with every kind present (so consumers can index safely). */
export function emptySideEffectCounts(): Record<SideEffectKind, number> {
  return {
    "local-read": 0,
    "local-write": 0,
    "connector-read": 0,
    "connector-write": 0,
    "external-http": 0,
    "agent-llm": 0,
    "nested-recipe": 0,
    unknown: 0,
  };
}
