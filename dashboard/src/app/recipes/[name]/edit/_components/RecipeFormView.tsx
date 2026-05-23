"use client";

import { useMemo } from "react";
import { parse as parseYaml } from "yaml";

// Minimal structural types — enough to render cards. Not exhaustive.
interface RecipeStep {
  id?: string;
  tool?: string;
  tools?: string[];
  agent?: { prompt?: string };
  risk?: string;
  into?: string;
  optional?: boolean;
  retry?: number;
  timeout_ms?: number;
}

interface RecipeTrigger {
  type?: string;
  at?: string;
  watch?: string | string[];
  on?: string;
}

interface RecipeDoc {
  name?: string;
  description?: string;
  version?: string;
  trigger?: RecipeTrigger;
  steps?: RecipeStep[];
}

interface ParseResult {
  doc: RecipeDoc | null;
  error: string | null;
}

function parseRecipeYaml(yaml: string): ParseResult {
  try {
    const doc = parseYaml(yaml) as RecipeDoc;
    if (!doc || typeof doc !== "object") return { doc: null, error: "Not a valid recipe YAML object." };
    return { doc, error: null };
  } catch (e) {
    return { doc: null, error: e instanceof Error ? e.message : String(e) };
  }
}

function TriggerBadge({ trigger }: { trigger: RecipeTrigger }) {
  const label =
    trigger.type === "cron"
      ? `Cron: ${trigger.at ?? "?"}`
      : trigger.type === "file_watch"
        ? `File watch: ${Array.isArray(trigger.watch) ? trigger.watch.join(", ") : (trigger.watch ?? "?")}`
        : trigger.type === "webhook"
          ? "Webhook"
          : trigger.type === "manual"
            ? "Manual"
            : trigger.type ?? "Unknown trigger";
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: "var(--r-1)",
        background: "var(--bg-3)",
        border: "1px solid var(--line-2)",
        fontSize: "var(--fs-xs)",
        fontFamily: "var(--font-mono)",
        color: "var(--ink-1)",
      }}
    >
      {label}
    </span>
  );
}

function RiskDot({ risk }: { risk: string | undefined }) {
  const color =
    risk === "high" ? "var(--err)" : risk === "medium" ? "var(--warn)" : "var(--ok, #4ade80)";
  return (
    <span
      title={`Risk: ${risk ?? "low"}`}
      aria-label={`Risk: ${risk ?? "low"}`}
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
      }}
    />
  );
}

function StepCard({ step, index }: { step: RecipeStep; index: number }) {
  const id = step.id ?? step.into ?? `step_${index + 1}`;
  const tools = step.tool
    ? [step.tool]
    : Array.isArray(step.tools)
      ? step.tools
      : step.agent
        ? ["agent"]
        : [];
  const isAgent = !!step.agent || (!step.tool && !step.tools);
  const prompt = step.agent?.prompt?.trim();

  return (
    <div
      style={{
        borderRadius: "var(--r-2)",
        border: "1px solid var(--line-2)",
        background: "var(--bg-1)",
        overflow: "hidden",
      }}
    >
      {/* Card header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--s-2)",
          padding: "10px var(--s-3)",
          borderBottom: "1px solid var(--line-2)",
          background: "var(--bg-2)",
        }}
      >
        <RiskDot risk={step.risk} />
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-s)",
            fontWeight: 600,
            color: "var(--ink-0)",
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {id}
        </span>
        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          {tools.map((t) => (
            <span
              key={t}
              style={{
                padding: "1px 6px",
                borderRadius: "var(--r-1)",
                background: isAgent ? "var(--info-soft, rgba(99,179,237,0.15))" : "var(--bg-3)",
                border: `1px solid ${isAgent ? "var(--info, #63b3ed)" : "var(--line-2)"}`,
                fontSize: "var(--fs-xs)",
                fontFamily: "var(--font-mono)",
                color: isAgent ? "var(--info, #63b3ed)" : "var(--ink-2)",
              }}
            >
              {t}
            </span>
          ))}
        </div>
        {step.optional && (
          <span style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)" }}>optional</span>
        )}
      </div>

      {/* Prompt preview */}
      {prompt && (
        <div
          style={{
            padding: "var(--s-2) var(--s-3)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-xs)",
            color: "var(--ink-2)",
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 96,
            overflow: "hidden",
            maskImage: "linear-gradient(to bottom, black 60%, transparent 100%)",
            WebkitMaskImage: "linear-gradient(to bottom, black 60%, transparent 100%)",
          }}
        >
          {prompt}
        </div>
      )}

      {/* Metadata footer */}
      {(step.into ?? step.retry ?? step.timeout_ms) && (
        <div
          style={{
            display: "flex",
            gap: "var(--s-3)",
            padding: "6px var(--s-3)",
            borderTop: "1px solid var(--line-2)",
            fontSize: "var(--fs-xs)",
            color: "var(--ink-3)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {step.into && <span>into: {step.into}</span>}
          {step.retry != null && <span>retry: {step.retry}</span>}
          {step.timeout_ms != null && <span>timeout: {step.timeout_ms}ms</span>}
        </div>
      )}
    </div>
  );
}

interface RecipeFormViewProps {
  yaml: string;
}

export function RecipeFormView({ yaml }: RecipeFormViewProps) {
  const { doc, error } = useMemo(() => parseRecipeYaml(yaml), [yaml]);

  if (!yaml.trim()) {
    return (
      <div
        style={{
          minHeight: 200,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--ink-3)",
          fontSize: "var(--fs-s)",
        }}
      >
        Recipe is empty — switch to YAML to start writing.
      </div>
    );
  }

  if (error || !doc) {
    return (
      <div
        style={{
          padding: "var(--s-3) var(--s-4)",
          borderRadius: "var(--r-2)",
          background: "var(--err-soft)",
          border: "1px solid var(--err)",
          color: "var(--err)",
          fontSize: "var(--fs-s)",
          fontFamily: "var(--font-mono)",
        }}
      >
        <strong>Cannot render form — YAML parse error:</strong>
        <br />
        {error ?? "Unknown error"}
      </div>
    );
  }

  const steps = Array.isArray(doc.steps) ? doc.steps : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
      {/* Recipe metadata card */}
      <div
        style={{
          borderRadius: "var(--r-2)",
          border: "1px solid var(--line-2)",
          background: "var(--bg-1)",
          padding: "var(--s-3) var(--s-4)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--s-2)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600, fontSize: "var(--fs-m)", color: "var(--ink-0)" }}>
            {doc.name ?? "(no name)"}
          </span>
          {doc.version && (
            <span style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>
              v{doc.version}
            </span>
          )}
          {doc.trigger && <TriggerBadge trigger={doc.trigger} />}
        </div>
        {doc.description && (
          <p style={{ margin: 0, fontSize: "var(--fs-s)", color: "var(--ink-2)", lineHeight: 1.5 }}>
            {doc.description}
          </p>
        )}
      </div>

      {/* Steps */}
      {steps.length === 0 ? (
        <div style={{ color: "var(--ink-3)", fontSize: "var(--fs-s)", textAlign: "center", padding: "var(--s-4)" }}>
          No steps defined yet.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
          <div style={{ fontSize: "var(--fs-s)", fontWeight: 600, color: "var(--ink-2)" }}>
            {steps.length} step{steps.length === 1 ? "" : "s"}
          </div>
          {steps.map((step, i) => (
            <StepCard key={step.id ?? step.into ?? i} step={step} index={i} />
          ))}
        </div>
      )}

      {/* Phase 2B-C notice */}
      <div
        style={{
          fontSize: "var(--fs-xs)",
          color: "var(--ink-3)",
          textAlign: "center",
          padding: "var(--s-2) 0",
        }}
      >
        Form view is read-only — editing coming in a future update. Switch to YAML to make changes.
      </div>
    </div>
  );
}
