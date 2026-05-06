"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiPath } from "@/lib/api";

interface PlanStep {
  id: string;
  type: "tool" | "agent" | "recipe";
  tool?: string;
  namespace?: string;
  into?: string;
  optional?: boolean;
  prompt?: string;
  dependencies?: string[];
  condition?: string;
  risk?: "low" | "medium" | "high";
  isWrite?: boolean;
  isConnector?: boolean;
  resolved?: boolean;
  recipe?: string;
}

interface DryRunPlan {
  recipe: string;
  mode: "dry-run";
  triggerType: string;
  generatedAt: string;
  steps: PlanStep[];
  parallelGroups?: string[][];
  connectorNamespaces?: string[];
  hasWriteSteps?: boolean;
  lint: { errors: string[]; warnings: string[] };
}

const RISK_COLORS: Record<string, string> = {
  low: "var(--ok)",
  medium: "var(--warn)",
  high: "var(--err)",
};

function RiskBadge({ risk }: { risk?: string }) {
  if (!risk) return null;
  return (
    <span
      style={{
        background: `color-mix(in srgb, ${RISK_COLORS[risk] ?? "var(--fg-3)"} 15%, transparent)`,
        border: `1px solid ${RISK_COLORS[risk] ?? "var(--border-default)"}`,
        borderRadius: 4,
        color: RISK_COLORS[risk] ?? "var(--fg-3)",
        fontSize: "var(--fs-xs)",
        fontWeight: 600,
        letterSpacing: "0.04em",
        padding: "1px 6px",
        textTransform: "uppercase",
      }}
    >
      {risk}
    </span>
  );
}

// Mirrors src/claudeOrchestrator.ts: ~4 chars per token for English/code.
// Steps without a prompt (raw tool calls) still consume a small request-
// envelope baseline, so we charge a flat 40 tokens to avoid implying free
// execution for tool-only steps.
const TOKENS_PER_CHAR = 0.25;
const TOOL_STEP_BASELINE_TOKENS = 40;

function estimateStepTokens(step: PlanStep): number {
  if (step.prompt) return Math.ceil(step.prompt.length * TOKENS_PER_CHAR);
  return TOOL_STEP_BASELINE_TOKENS;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return n.toLocaleString();
}

// Rough lower-bound cost using Claude Sonnet input pricing ($3 / 1M tokens).
// Output tokens cost more, but we have no way to estimate output size from
// a static plan. Surfacing the input-only floor keeps users honest about
// "approximately, at least this much" without overpromising.
const INPUT_COST_PER_TOKEN = 3 / 1_000_000;

function formatCost(tokens: number): string {
  const usd = tokens * INPUT_COST_PER_TOKEN;
  if (usd < 0.001) return "<$0.001";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function TypeBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    tool: "var(--accent)",
    agent: "var(--purple)",
    recipe: "var(--blue)",
  };
  const color = colors[type] ?? "var(--fg-3)";
  return (
    <span
      style={{
        background: `color-mix(in srgb, ${color} 15%, transparent)`,
        border: `1px solid ${color}`,
        borderRadius: 4,
        color,
        fontSize: "var(--fs-xs)",
        fontWeight: 600,
        letterSpacing: "0.04em",
        padding: "1px 6px",
      }}
    >
      {type}
    </span>
  );
}

export default function RecipePlanPage({
  params,
}: {
  params: { name: string };
}) {
  const name = decodeURIComponent(params.name);
  const [plan, setPlan] = useState<DryRunPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          apiPath(`/api/bridge/recipes/${encodeURIComponent(name)}/plan`),
        );
        const data = (await res.json()) as {
          plan?: DryRunPlan;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || !data.plan) {
          setError(data.error ?? "Failed to load plan.");
        } else {
          setPlan(data.plan);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [name]);

  return (
    <section>
      <div className="page-head">
        <div>
          <div style={{ marginBottom: "var(--s-1)" }}>
            <Link
              href={`/recipes/${encodeURIComponent(name)}/edit`}
              style={{
                color: "var(--fg-3)",
                fontSize: "var(--fs-m)",
                textDecoration: "none",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              &#8592; Edit {name}
            </Link>
          </div>
          <h1 style={{ marginTop: 0 }}>
            Dry-run plan:{" "}
            <code
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.85em",
                background: "var(--bg-2)",
                padding: "2px 8px",
                borderRadius: "var(--r-1)",
              }}
            >
              {name}
            </code>
          </h1>
          <div className="page-head-sub">
            Static analysis of what this recipe will do — no execution.
          </div>
        </div>
        <div style={{ display: "flex", gap: "var(--s-3)", alignItems: "center" }}>
          <Link
            href={`/recipes/${encodeURIComponent(name)}/edit`}
            className="btn"
          >
            Edit
          </Link>
        </div>
      </div>

      {loading && (
        <p style={{ color: "var(--fg-3)", fontSize: "var(--fs-base)" }}>Loading plan…</p>
      )}

      {error && (
        <div
          style={{
            background: "var(--err-soft)",
            border: "1px solid var(--err)",
            borderRadius: "var(--r-2)",
            color: "var(--err)",
            fontSize: "var(--fs-m)",
            padding: "var(--s-3) var(--s-4)",
          }}
        >
          {error}
        </div>
      )}

      {plan && (() => {
        const totalTokens = plan.steps.reduce(
          (sum, s) => sum + estimateStepTokens(s),
          0,
        );
        return (
        <div
          style={{ display: "flex", flexDirection: "column", gap: "var(--s-5)" }}
        >
          {/* Meta row */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "var(--s-4)",
              fontSize: "var(--fs-m)",
              color: "var(--fg-2)",
            }}
          >
            <span>
              Trigger:{" "}
              <strong style={{ color: "var(--fg-0)" }}>
                {plan.triggerType}
              </strong>
            </span>
            <span>
              Steps:{" "}
              <strong style={{ color: "var(--fg-0)" }}>
                {plan.steps.length}
              </strong>
            </span>
            <span
              title={`Est. ${totalTokens.toLocaleString()} input tokens (≈4 chars/token, +${TOOL_STEP_BASELINE_TOKENS} baseline per tool-only step). Output tokens not counted.`}
            >
              Est. tokens:{" "}
              <strong style={{ color: "var(--fg-0)" }}>
                ~{formatTokens(totalTokens)}
              </strong>
            </span>
            <span
              title="Lower-bound input-only cost @ $3/M (Sonnet pricing). Output tokens & cache effects not modelled — actual bill will be higher."
            >
              Min. cost:{" "}
              <strong style={{ color: "var(--fg-0)" }}>
                ≥ {formatCost(totalTokens)}
              </strong>
            </span>
            {plan.hasWriteSteps && (
              <span style={{ color: "var(--warn)" }}>
                ⚠ Has write steps
              </span>
            )}
            {plan.connectorNamespaces && plan.connectorNamespaces.length > 0 && (
              <span>
                Connectors:{" "}
                <strong style={{ color: "var(--fg-0)" }}>
                  {plan.connectorNamespaces.join(", ")}
                </strong>
              </span>
            )}
            <span style={{ marginLeft: "auto", color: "var(--fg-3)" }}>
              Generated {new Date(plan.generatedAt).toLocaleTimeString()}
            </span>
          </div>

          {/* Lint */}
          {(plan.lint.errors.length > 0 || plan.lint.warnings.length > 0) && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--s-2)",
              }}
            >
              {plan.lint.errors.map((e) => (
                <div
                  key={e}
                  style={{
                    background: "var(--err-soft)",
                    border: "1px solid var(--err)",
                    borderRadius: "var(--r-2)",
                    color: "var(--err)",
                    fontSize: "var(--fs-m)",
                    padding: "var(--s-2) var(--s-3)",
                  }}
                >
                  ✕ {e}
                </div>
              ))}
              {plan.lint.warnings.map((w) => (
                <div
                  key={w}
                  style={{
                    background:
                      "color-mix(in srgb, var(--warn) 10%, transparent)",
                    border: "1px solid var(--warn)",
                    borderRadius: "var(--r-2)",
                    color: "var(--warn)",
                    fontSize: "var(--fs-m)",
                    padding: "var(--s-2) var(--s-3)",
                  }}
                >
                  ⚠ {w}
                </div>
              ))}
            </div>
          )}

          {/* Steps table */}
          <div
            style={{
              border: "1px solid var(--border-default)",
              borderRadius: "var(--r-2)",
              overflow: "hidden",
            }}
          >
            <table
              style={{
                borderCollapse: "collapse",
                fontSize: "var(--fs-m)",
                width: "100%",
              }}
            >
              <thead>
                <tr
                  style={{
                    background: "var(--bg-2)",
                    borderBottom: "1px solid var(--border-default)",
                  }}
                >
                  {["#", "ID", "Type", "Tool / Prompt", "Output", "Risk", "Flags"].map(
                    (h) => (
                      <th
                        key={h}
                        style={{
                          color: "var(--fg-2)",
                          fontWeight: 600,
                          fontSize: "var(--fs-xs)",
                          letterSpacing: "0.04em",
                          padding: "var(--s-2) var(--s-3)",
                          textAlign: "left",
                          textTransform: "uppercase",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {plan.steps.map((step, i) => (
                  <tr
                    key={step.id}
                    style={{
                      borderBottom:
                        i < plan.steps.length - 1
                          ? "1px solid var(--border-default)"
                          : "none",
                      background:
                        step.resolved === false
                          ? "color-mix(in srgb, var(--err) 6%, transparent)"
                          : "transparent",
                    }}
                  >
                    <td
                      style={{
                        color: "var(--fg-3)",
                        padding: "var(--s-2) var(--s-3)",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {i + 1}
                    </td>
                    <td
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "var(--fs-s)",
                        padding: "var(--s-2) var(--s-3)",
                        color: "var(--fg-0)",
                      }}
                    >
                      {step.id}
                      {step.optional && (
                        <span
                          style={{
                            color: "var(--fg-3)",
                            fontSize: "var(--fs-xs)",
                            marginLeft: 4,
                          }}
                        >
                          (optional)
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "var(--s-2) var(--s-3)" }}>
                      <TypeBadge type={step.type} />
                    </td>
                    <td
                      style={{
                        color:
                          step.resolved === false
                            ? "var(--err)"
                            : "var(--fg-1)",
                        fontFamily: step.tool ? "var(--font-mono)" : undefined,
                        fontSize: step.tool ? 12 : 13,
                        maxWidth: 360,
                        padding: "var(--s-2) var(--s-3)",
                      }}
                    >
                      {step.tool ? (
                        <>
                          {step.tool}
                          {step.resolved === false && (
                            <span
                              style={{
                                color: "var(--err)",
                                fontSize: "var(--fs-xs)",
                                marginLeft: 6,
                              }}
                            >
                              unresolved
                            </span>
                          )}
                        </>
                      ) : step.recipe ? (
                        <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-s)" }}>
                          recipe: {step.recipe}
                        </span>
                      ) : step.prompt ? (
                        <span
                          style={{
                            display: "-webkit-box",
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: "vertical",
                            overflow: "hidden",
                          }}
                          title={step.prompt}
                        >
                          {step.prompt}
                        </span>
                      ) : (
                        <span style={{ color: "var(--fg-3)" }}>—</span>
                      )}
                    </td>
                    <td
                      style={{
                        color: "var(--fg-3)",
                        fontFamily: "var(--font-mono)",
                        fontSize: "var(--fs-xs)",
                        padding: "var(--s-2) var(--s-3)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {step.into ?? "—"}
                    </td>
                    <td style={{ padding: "var(--s-2) var(--s-3)" }}>
                      <RiskBadge risk={step.risk} />
                    </td>
                    <td
                      style={{
                        color: "var(--fg-3)",
                        fontSize: "var(--fs-s)",
                        padding: "var(--s-2) var(--s-3)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {[
                        step.isWrite && "write",
                        step.isConnector && "connector",
                        step.condition && `if: ${step.condition}`,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Parallel groups */}
          {plan.parallelGroups && plan.parallelGroups.length > 0 && (
            <div>
              <h3
                style={{
                  color: "var(--fg-1)",
                  fontSize: "var(--fs-m)",
                  fontWeight: 600,
                  margin: "0 0 var(--s-2) 0",
                }}
              >
                Parallel groups
              </h3>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "var(--s-2)",
                }}
              >
                {plan.parallelGroups.map((group, i) => (
                  <div
                    key={i}
                    style={{
                      background: "var(--bg-2)",
                      border: "1px solid var(--border-default)",
                      borderRadius: "var(--r-2)",
                      fontSize: "var(--fs-s)",
                      fontFamily: "var(--font-mono)",
                      padding: "var(--s-1) var(--s-3)",
                    }}
                  >
                    [{group.join(", ")}]
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        );
      })()}
    </section>
  );
}
