"use client";

import { useCallback, useMemo, useRef } from "react";
import { parseDocument, Document as YamlDocument, YAMLMap, YAMLSeq } from "yaml";
import type { YamlLintIssue } from "./YamlEditor";

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
  yamlDoc: YamlDocument | null;
  error: string | null;
}

function parseRecipeYaml(yaml: string): ParseResult {
  try {
    const yamlDoc = parseDocument(yaml, { keepSourceTokens: true });
    if (yamlDoc.errors.length > 0) {
      return { doc: null, yamlDoc: null, error: yamlDoc.errors[0]?.message ?? "YAML parse error" };
    }
    const doc = yamlDoc.toJS() as RecipeDoc;
    if (!doc || typeof doc !== "object") {
      return { doc: null, yamlDoc: null, error: "Not a valid recipe YAML object." };
    }
    return { doc, yamlDoc, error: null };
  } catch (e) {
    return { doc: null, yamlDoc: null, error: e instanceof Error ? e.message : String(e) };
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

/** Shared label + input layout used in both metadata and step cards. */
function FieldRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label
        style={{
          fontSize: "var(--fs-xs)",
          fontWeight: 600,
          color: "var(--ink-2)",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 10px",
  borderRadius: "var(--r-2)",
  border: "1px solid var(--line-2)",
  background: "var(--bg-0)",
  color: "var(--ink-0)",
  fontSize: "var(--fs-s)",
  fontFamily: "inherit",
  lineHeight: 1.5,
  boxSizing: "border-box",
  outline: "none",
  transition: "border-color 0.12s",
};

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-xs)",
  resize: "vertical",
  minHeight: 80,
};

interface StepCardProps {
  step: RecipeStep;
  index: number;
  total: number;
  editable: boolean;
  onChangeField: (stepIndex: number, path: string[], value: string) => void;
  onRemove: (index: number) => void;
  onMove: (index: number, direction: "up" | "down") => void;
  stepIssues: YamlLintIssue[];
}

const iconBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  cursor: "pointer",
  padding: "2px 4px",
  borderRadius: "var(--r-1)",
  color: "var(--ink-3)",
  display: "inline-flex",
  alignItems: "center",
  fontSize: 14,
  lineHeight: 1,
  minHeight: 24,
};

function StepCard({ step, index, total, editable, onChangeField, onRemove, onMove, stepIssues }: StepCardProps) {
  const id = step.id ?? step.into ?? `step_${index + 1}`;
  const tools = step.tool
    ? [step.tool]
    : Array.isArray(step.tools)
      ? step.tools
      : step.agent
        ? ["agent"]
        : [];
  const isAgent = !!step.agent || (!step.tool && !step.tools);
  const prompt = step.agent?.prompt ?? "";

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
        {stepIssues.length > 0 && (
          <span
            title={stepIssues.map((i) => i.message).join("\n")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minWidth: 18,
              height: 18,
              borderRadius: 9,
              background: stepIssues.some((i) => i.level === "error") ? "var(--err)" : "var(--warn)",
              color: "#fff",
              fontSize: 10,
              fontWeight: 700,
              lineHeight: 1,
              padding: "0 5px",
              flexShrink: 0,
            }}
          >
            {stepIssues.length}
          </span>
        )}
        {editable && (
          <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
            <button
              type="button"
              style={iconBtnStyle}
              disabled={index === 0}
              onClick={() => onMove(index, "up")}
              aria-label="Move step up"
              title="Move up"
            >
              ▲
            </button>
            <button
              type="button"
              style={iconBtnStyle}
              disabled={index === total - 1}
              onClick={() => onMove(index, "down")}
              aria-label="Move step down"
              title="Move down"
            >
              ▼
            </button>
            <button
              type="button"
              style={{ ...iconBtnStyle, color: "var(--err)" }}
              onClick={() => {
                if (window.confirm(`Remove step "${id}"?`)) onRemove(index);
              }}
              aria-label="Remove step"
              title="Remove step"
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {/* Editable body */}
      <div style={{ padding: "var(--s-3)", display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
        {/* Tool field (non-agent steps) */}
        {!isAgent && step.tool !== undefined && (
          <FieldRow label="Tool">
            {editable ? (
              <input
                style={inputStyle}
                value={step.tool}
                onChange={(e) => onChangeField(index, ["tool"], e.target.value)}
                placeholder="e.g. inbox.fetch"
              />
            ) : (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-s)", color: "var(--ink-1)" }}>
                {step.tool}
              </span>
            )}
          </FieldRow>
        )}

        {/* Agent prompt */}
        {isAgent && (
          <FieldRow label="Prompt">
            {editable ? (
              <textarea
                style={textareaStyle}
                value={prompt}
                onChange={(e) => onChangeField(index, ["agent", "prompt"], e.target.value)}
                placeholder="Describe what the agent should do…"
                rows={Math.max(4, prompt.split("\n").length + 1)}
              />
            ) : (
              prompt ? (
                <pre
                  style={{
                    margin: 0,
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--fs-xs)",
                    color: "var(--ink-2)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    maxHeight: 96,
                    overflow: "hidden",
                    maskImage: "linear-gradient(to bottom, black 60%, transparent 100%)",
                    WebkitMaskImage: "linear-gradient(to bottom, black 60%, transparent 100%)",
                  }}
                >
                  {prompt}
                </pre>
              ) : (
                <span style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)" }}>(no prompt)</span>
              )
            )}
          </FieldRow>
        )}

        {/* into field */}
        {step.into !== undefined && (
          <FieldRow label="Output variable (into)">
            {editable ? (
              <input
                style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
                value={step.into}
                onChange={(e) => onChangeField(index, ["into"], e.target.value)}
                placeholder="e.g. results"
              />
            ) : (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-s)", color: "var(--ink-1)" }}>
                {step.into}
              </span>
            )}
          </FieldRow>
        )}
      </div>

      {/* Metadata footer */}
      {(step.retry != null || step.timeout_ms != null) && (
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
          {step.retry != null && <span>retry: {step.retry}</span>}
          {step.timeout_ms != null && <span>timeout: {step.timeout_ms}ms</span>}
        </div>
      )}
    </div>
  );
}

interface RecipeFormViewProps {
  yaml: string;
  onChange?: (yaml: string) => void;
  lintIssues?: YamlLintIssue[];
}

export function RecipeFormView({ yaml, onChange, lintIssues = [] }: RecipeFormViewProps) {
  const editable = !!onChange;

  const { doc, yamlDoc, error } = useMemo(() => parseRecipeYaml(yaml), [yaml]);

  // Stable ref so mutation callbacks don't need to re-close over yamlDoc
  const yamlDocRef = useRef<YamlDocument | null>(null);
  yamlDocRef.current = yamlDoc;

  const emitChange = useCallback(
    (mutate: (d: YamlDocument) => void) => {
      if (!yamlDocRef.current || !onChange) return;
      // Clone to avoid mutating the cached parse result
      const clone = parseDocument(yaml, { keepSourceTokens: true });
      mutate(clone);
      onChange(String(clone));
    },
    // yaml changes → new yamlDoc → ref updates; onChange is stable from parent
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [yaml, onChange],
  );

  const handleMetaChange = useCallback(
    (key: "name" | "description", value: string) => {
      emitChange((d) => d.setIn([key], value));
    },
    [emitChange],
  );

  const handleStepFieldChange = useCallback(
    (stepIndex: number, path: string[], value: string) => {
      emitChange((d) => {
        const stepsNode = d.get("steps", true);
        if (!(stepsNode instanceof YAMLSeq)) return;
        const stepNode = stepsNode.get(stepIndex, true);
        if (!(stepNode instanceof YAMLMap)) return;
        // For nested path (e.g. ["agent", "prompt"]), walk into the node
        if (path.length === 1) {
          stepNode.set(path[0], value);
        } else {
          // path.length === 2 (e.g. agent.prompt)
          const parentKey = path[0]!;
          const childKey = path[1]!;
          const parent = stepNode.get(parentKey, true);
          if (!(parent instanceof YAMLMap)) {
            // Create the parent map if it doesn't exist yet
            stepNode.set(parentKey, d.createNode({ [childKey]: value }));
          } else {
            parent.set(childKey, value);
          }
        }
      });
    },
    [emitChange],
  );

  const handleAddStep = useCallback(
    (kind: "agent" | "tool") => {
      emitChange((d) => {
        let stepsNode = d.get("steps", true);
        if (!(stepsNode instanceof YAMLSeq)) {
          stepsNode = d.createNode([]) as YAMLSeq;
          d.set("steps", stepsNode);
        }
        const seq = stepsNode as YAMLSeq;
        const idx = seq.items.length;
        const newStep =
          kind === "agent"
            ? d.createNode({ id: `step_${idx + 1}`, agent: { prompt: "" }, into: `out_${idx + 1}` })
            : d.createNode({ id: `step_${idx + 1}`, tool: "", into: `out_${idx + 1}` });
        seq.add(newStep);
      });
    },
    [emitChange],
  );

  const handleRemoveStep = useCallback(
    (stepIndex: number) => {
      emitChange((d) => {
        const stepsNode = d.get("steps", true);
        if (!(stepsNode instanceof YAMLSeq)) return;
        stepsNode.items.splice(stepIndex, 1);
      });
    },
    [emitChange],
  );

  const handleMoveStep = useCallback(
    (stepIndex: number, direction: "up" | "down") => {
      emitChange((d) => {
        const stepsNode = d.get("steps", true);
        if (!(stepsNode instanceof YAMLSeq)) return;
        const items = stepsNode.items;
        const targetIndex = direction === "up" ? stepIndex - 1 : stepIndex + 1;
        if (targetIndex < 0 || targetIndex >= items.length) return;
        // Swap
        const tmp = items[stepIndex]!;
        items[stepIndex] = items[targetIndex]!;
        items[targetIndex] = tmp;
      });
    },
    [emitChange],
  );

  // Map lint issues to step indices by matching path prefix "steps.N"
  const issuesByStep = useMemo(() => {
    const map = new Map<number, YamlLintIssue[]>();
    for (const issue of lintIssues) {
      const m = issue.path?.match(/^steps\.(\d+)/);
      if (!m) continue;
      const idx = parseInt(m[1]!, 10);
      const bucket = map.get(idx) ?? [];
      bucket.push(issue);
      map.set(idx, bucket);
    }
    return map;
  }, [lintIssues]);

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
          gap: "var(--s-3)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)", flexWrap: "wrap" }}>
          {doc.version && (
            <span style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>
              v{doc.version}
            </span>
          )}
          {doc.trigger && <TriggerBadge trigger={doc.trigger} />}
        </div>
        <FieldRow label="Name">
          {editable ? (
            <input
              style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
              value={doc.name ?? ""}
              onChange={(e) => handleMetaChange("name", e.target.value)}
              placeholder="recipe-name"
            />
          ) : (
            <span style={{ fontWeight: 600, fontSize: "var(--fs-m)", color: "var(--ink-0)" }}>
              {doc.name ?? "(no name)"}
            </span>
          )}
        </FieldRow>
        <FieldRow label="Description">
          {editable ? (
            <textarea
              style={{ ...textareaStyle, fontFamily: "inherit", minHeight: 56 }}
              value={doc.description ?? ""}
              onChange={(e) => handleMetaChange("description", e.target.value)}
              placeholder="What does this recipe do?"
              rows={2}
            />
          ) : doc.description ? (
            <p style={{ margin: 0, fontSize: "var(--fs-s)", color: "var(--ink-2)", lineHeight: 1.5 }}>
              {doc.description}
            </p>
          ) : null}
        </FieldRow>
      </div>

      {/* Steps */}
      {steps.length === 0 && !editable ? (
        <div style={{ color: "var(--ink-3)", fontSize: "var(--fs-s)", textAlign: "center", padding: "var(--s-4)" }}>
          No steps defined yet.
        </div>
      ) : steps.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
          <div style={{ fontSize: "var(--fs-s)", fontWeight: 600, color: "var(--ink-2)" }}>
            {steps.length} step{steps.length === 1 ? "" : "s"}
          </div>
          {steps.map((step, i) => (
            <StepCard
              key={step.id ?? step.into ?? i}
              step={step}
              index={i}
              total={steps.length}
              editable={editable}
              onChangeField={handleStepFieldChange}
              onRemove={handleRemoveStep}
              onMove={handleMoveStep}
              stepIssues={issuesByStep.get(i) ?? []}
            />
          ))}
        </div>
      ) : null}

      {/* Add step controls (editable mode only) */}
      {editable && (
        <div style={{ display: "flex", gap: "var(--s-2)", justifyContent: "center" }}>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => handleAddStep("agent")}
            title="Append an agent step with a prompt"
          >
            + Agent step
          </button>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => handleAddStep("tool")}
            title="Append a tool step"
          >
            + Tool step
          </button>
        </div>
      )}

      {!editable && (
        <div
          style={{
            fontSize: "var(--fs-xs)",
            color: "var(--ink-3)",
            textAlign: "center",
            padding: "var(--s-2) 0",
          }}
        >
          Read-only — switch to YAML to edit directly.
        </div>
      )}
    </div>
  );
}
