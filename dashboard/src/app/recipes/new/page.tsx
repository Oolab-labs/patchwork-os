"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useMemo, useState } from "react";
import { apiPath } from "@/lib/api";

interface Step {
  id: string;
  agent: boolean;
  prompt: string;
}

interface RecipeVar {
  name: string;
  description: string;
  required: boolean;
  default: string;
}

interface TriggerState {
  type: "manual" | "webhook" | "schedule";
  path: string;
  cron: string;
}

interface FormState {
  name: string;
  description: string;
  trigger: TriggerState;
  steps: Step[];
  vars: RecipeVar[];
}

interface ValidationState {
  triggerPath: string | null;
  cron: string | null;
  steps: Array<string | null>;
  vars: Array<string | null>;
}

function makeStepId(index: number): string {
  return `step-${index + 1}`;
}

function makeNextStepId(steps: Step[]): string {
  const used = new Set(steps.map((step) => step.id.trim()).filter(Boolean));
  let index = steps.length;
  let candidate = makeStepId(index);
  while (used.has(candidate)) {
    index += 1;
    candidate = makeStepId(index);
  }
  return candidate;
}

function emptyValidationState(form: FormState): ValidationState {
  return {
    triggerPath: null,
    cron: null,
    steps: form.steps.map(() => null),
    vars: form.vars.map(() => null),
  };
}

function validateForm(form: FormState): ValidationState {
  const errors = emptyValidationState(form);

  if (form.trigger.type === "webhook" && !form.trigger.path.trim()) {
    errors.triggerPath = "Webhook path is required.";
  }

  if (form.trigger.type === "schedule" && !form.trigger.cron.trim()) {
    errors.cron = "Cron expression is required.";
  }

  for (let i = 0; i < form.steps.length; i++) {
    if (!form.steps[i]?.prompt.trim()) {
      errors.steps[i] = "Step prompt is required.";
    }
  }

  const firstVarIndexByName = new Map<string, number>();
  for (let i = 0; i < form.vars.length; i++) {
    const name = form.vars[i]?.name.trim() ?? "";
    if (!name) {
      errors.vars[i] = "Variable name is required.";
      continue;
    }
    const existingIndex = firstVarIndexByName.get(name);
    if (existingIndex !== undefined) {
      errors.vars[i] = "Variable name must be unique.";
      errors.vars[existingIndex] ??= "Variable name must be unique.";
      continue;
    }
    firstVarIndexByName.set(name, i);
  }

  return errors;
}

function hasValidationErrors(errors: ValidationState): boolean {
  return Boolean(
    errors.triggerPath ||
      errors.cron ||
      errors.steps.some(Boolean) ||
      errors.vars.some(Boolean),
  );
}

const RECIPE_SCHEMA_HEADER =
  "# yaml-language-server: $schema=https://raw.githubusercontent.com/patchworkos/recipes/main/schema/recipe.v1.json";
const RECIPE_API_VERSION = "patchwork.sh/v1";
const SIMPLE_YAML_VALUE_RE = /^[A-Za-z0-9_./:@%+-]+$/;
const AMBIGUOUS_YAML_VALUE_RE = /^(true|false|null|~|-?\d+(\.\d+)?)$/i;

function normalizeRecipeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

function yamlScalar(value: string): string {
  if (!value) {
    return '""';
  }
  if (
    SIMPLE_YAML_VALUE_RE.test(value) &&
    !AMBIGUOUS_YAML_VALUE_RE.test(value)
  ) {
    return value;
  }
  return JSON.stringify(value);
}

function pushYamlField(
  lines: string[],
  indent: number,
  key: string,
  value: string,
): void {
  const prefix = " ".repeat(indent);
  const normalized = value.replace(/\r\n/g, "\n");
  if (!normalized.includes("\n")) {
    lines.push(`${prefix}${key}: ${yamlScalar(normalized)}`);
    return;
  }
  lines.push(`${prefix}${key}: |`);
  for (const line of normalized.split("\n")) {
    lines.push(`${prefix}  ${line}`);
  }
}

function makeStepOutputKey(stepId: string): string {
  const normalized = stepId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "step_output";
}

function buildRecipeYaml(form: FormState, safeName: string): string {
  const lines: string[] = [
    RECIPE_SCHEMA_HEADER,
    `apiVersion: ${RECIPE_API_VERSION}`,
    `name: ${yamlScalar(safeName || "(name)")}`,
  ];

  if (form.description.trim()) {
    pushYamlField(lines, 0, "description", form.description.trim());
  }

  lines.push("trigger:");
  if (form.trigger.type === "webhook") {
    const path = form.trigger.path.trim().replace(/^\/+/, "");
    lines.push("  type: webhook");
    pushYamlField(lines, 2, "path", `/hooks/${path || "(path)"}`);
  } else if (form.trigger.type === "schedule") {
    lines.push("  type: cron");
    pushYamlField(lines, 2, "at", form.trigger.cron.trim() || "(cron)");
  } else {
    lines.push("  type: manual");
  }

  if (form.vars.length > 0) {
    lines.push("vars:");
    for (const variable of form.vars) {
      lines.push(`  - name: ${yamlScalar(variable.name.trim() || "(name)")}`);
      if (variable.description.trim()) {
        pushYamlField(lines, 4, "description", variable.description.trim());
      }
      if (variable.required) {
        lines.push("    required: true");
      }
      if (variable.default) {
        pushYamlField(lines, 4, "default", variable.default);
      }
    }
  }

  lines.push("steps:");
  for (let i = 0; i < form.steps.length; i++) {
    const step = form.steps[i];
    const stepId = step?.id.trim() || makeStepId(i);
    lines.push(`  - id: ${yamlScalar(stepId)}`);
    lines.push("    agent:");
    pushYamlField(lines, 6, "prompt", step?.prompt.trim() || "(empty)");
    lines.push(`      into: ${yamlScalar(makeStepOutputKey(stepId))}`);
  }

  return lines.join("\n");
}

const NAME_RE = /^[a-z0-9][a-z0-9_\- ]{0,63}$/i;

export default function NewRecipePage() {
  return (
    <Suspense
      fallback={
        <div className="empty-state" role="status" aria-live="polite">
          <p>Loading recipe editor…</p>
        </div>
      }
    >
      <NewRecipePageInner />
    </Suspense>
  );
}

function NewRecipePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const seedVars: RecipeVar[] = (searchParams.get("vars") ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((name) => ({ name, description: "", required: false, default: "" }));

  const initialForm: FormState = {
    name: "",
    description: "",
    trigger: { type: "manual", path: "", cron: "" },
    steps: [{ id: "step-1", agent: true, prompt: "" }],
    vars: seedVars,
  };

  const [form, setForm] = useState<FormState>(initialForm);
  const [nameError, setNameError] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationState>(() =>
    emptyValidationState(initialForm),
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitNotice, setSubmitNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState<{
    yaml?: string;
    warnings?: string[];
    error?: string;
  } | null>(null);

  const setName = useCallback((v: string) => {
    setForm((f) => ({ ...f, name: v }));
    if (v && !NAME_RE.test(v)) {
      setNameError(
        "Name must start with a letter or digit and contain only letters, digits, spaces, hyphens, or underscores (max 64 chars).",
      );
    } else {
      setNameError(null);
    }
    setSubmitError(null);
  }, []);

  const setDescription = useCallback((v: string) => {
    setForm((f) => ({ ...f, description: v }));
    setSubmitError(null);
  }, []);

  const setTriggerType = useCallback(
    (type: "manual" | "webhook" | "schedule") => {
      setForm((f) => ({ ...f, trigger: { ...f.trigger, type } }));
      setValidation((current) => ({
        ...current,
        triggerPath: null,
        cron: null,
      }));
      setSubmitError(null);
    },
    [],
  );

  const setTriggerPath = useCallback((path: string) => {
    setForm((f) => ({ ...f, trigger: { ...f.trigger, path } }));
    setValidation((current) => ({ ...current, triggerPath: null }));
    setSubmitError(null);
  }, []);

  const setTriggerCron = useCallback((cron: string) => {
    setForm((f) => ({ ...f, trigger: { ...f.trigger, cron } }));
    setValidation((current) => ({ ...current, cron: null }));
    setSubmitError(null);
  }, []);

  const updateStep = useCallback((index: number, prompt: string) => {
    setForm((f) => {
      const steps = f.steps.map((s, i) => (i === index ? { ...s, prompt } : s));
      return { ...f, steps };
    });
    setValidation((current) => ({
      ...current,
      steps: current.steps.map((message, i) => (i === index ? null : message)),
    }));
    setSubmitError(null);
  }, []);

  const addStep = useCallback(() => {
    setForm((f) => {
      const steps = [
        ...f.steps,
        { id: makeNextStepId(f.steps), agent: true, prompt: "" },
      ];
      return { ...f, steps };
    });
    setValidation((current) => ({ ...current, steps: [...current.steps, null] }));
    setSubmitError(null);
  }, []);

  const removeStep = useCallback((index: number) => {
    setForm((f) => {
      if (f.steps.length <= 1) return f;
      const steps = f.steps.filter((_, i) => i !== index);
      return { ...f, steps };
    });
    setValidation((current) => ({
      ...current,
      steps: current.steps.filter((_, i) => i !== index),
    }));
    setSubmitError(null);
  }, []);

  const moveStep = useCallback((index: number, direction: "up" | "down") => {
    setForm((f) => {
      const steps = [...f.steps];
      const target = direction === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= steps.length) return f;
      const tmp = steps[index];
      steps[index] = steps[target] as (typeof steps)[number];
      steps[target] = tmp as (typeof steps)[number];
      return { ...f, steps };
    });
    setValidation((current) => {
      const steps = [...current.steps];
      const target = direction === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= steps.length) return current;
      const tmp = steps[index];
      steps[index] = steps[target] ?? null;
      steps[target] = tmp ?? null;
      return { ...current, steps };
    });
    setSubmitError(null);
  }, []);

  const addVar = useCallback(() => {
    setForm((f) => ({
      ...f,
      vars: [
        ...f.vars,
        { name: "", description: "", required: false, default: "" },
      ],
    }));
    setValidation((current) => ({ ...current, vars: [...current.vars, null] }));
    setSubmitError(null);
  }, []);

  const removeVar = useCallback((index: number) => {
    setForm((f) => ({
      ...f,
      vars: f.vars.filter((_, i) => i !== index),
    }));
    setValidation((current) => ({
      ...current,
      vars: current.vars.filter((_, i) => i !== index),
    }));
    setSubmitError(null);
  }, []);

  const updateVar = useCallback(
    (index: number, field: keyof RecipeVar, value: string | boolean) => {
      setForm((f) => ({
        ...f,
        vars: f.vars.map((v, i) =>
          i === index ? { ...v, [field]: value } : v,
        ),
      }));
      if (field === "name") {
        setValidation((current) => ({
          ...current,
          vars: current.vars.map((message, i) => (i === index ? null : message)),
        }));
      }
      setSubmitError(null);
    },
    [],
  );

  const safeName = useMemo(() => normalizeRecipeName(form.name), [form.name]);

  const previewYaml = useMemo(
    () => buildRecipeYaml(form, safeName),
    [form, safeName],
  );

  async function handleGenerate() {
    if (!aiPrompt.trim()) return;
    setAiLoading(true);
    setAiResult(null);
    try {
      const res = await fetch(apiPath("/api/bridge/recipes/generate"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: aiPrompt }),
      });
      const text = await res.text();
      let data: {
        ok?: boolean;
        yaml?: string;
        warnings?: string[];
        error?: string;
        unavailable?: boolean;
      } = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        setAiResult({
          error: `Generation failed: HTTP ${res.status} ${res.statusText || ""}`.trim(),
        });
        return;
      }
      if (!res.ok && !data.error && !data.unavailable) {
        setAiResult({
          error: `Generation failed: HTTP ${res.status} ${res.statusText || ""}`.trim(),
        });
        return;
      }
      if (data.unavailable) {
        setAiResult({
          error:
            data.error ??
            "AI generation is not available — start the bridge with --claude-driver subprocess.",
        });
      } else if (data.ok && data.yaml) {
        setAiResult({ yaml: data.yaml, warnings: data.warnings });
      } else if (data.yaml) {
        setAiResult({
          yaml: data.yaml,
          warnings: data.warnings,
          error: "Generated YAML has validation errors — review warnings below.",
        });
      } else {
        setAiResult({ error: data.error ?? "Generation failed." });
      }
    } catch (err) {
      setAiResult({
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setAiLoading(false);
    }
  }

  function applyAiYaml(yaml: string) {
    // Best-effort parse into form fields. On failure, keep the YAML visible
    // so the user can copy it manually.
    try {
      const lines = yaml.split("\n");
      const nameMatch = lines.find((l) => /^name:\s/.test(l));
      const descMatch = lines.find((l) => /^description:\s/.test(l));
      const triggerTypeMatch = lines.find((l) => /^\s+type:\s/.test(l));
      const triggerAtMatch = lines.find((l) => /^\s+at:\s/.test(l));
      const triggerPathMatch = lines.find((l) => /^\s+path:\s/.test(l));

      const parsedName = nameMatch
        ? (nameMatch.replace(/^name:\s*/, "").trim().replace(/^"|"$/g, "") ?? "")
        : "";
      const parsedDesc = descMatch
        ? (descMatch
            .replace(/^description:\s*/, "")
            .trim()
            .replace(/^"|"$/g, "") ?? "")
        : "";
      const parsedTriggerType = triggerTypeMatch
        ? (triggerTypeMatch.replace(/^\s+type:\s*/, "").trim() as
            | "manual"
            | "webhook"
            | "schedule"
            | "cron")
        : "manual";
      const normalizedType: "manual" | "webhook" | "schedule" =
        parsedTriggerType === "cron" ? "schedule" : parsedTriggerType === "webhook" ? "webhook" : "manual";
      const parsedCron = triggerAtMatch
        ? triggerAtMatch
            .replace(/^\s+at:\s*/, "")
            .trim()
            .replace(/^"|"$/g, "")
        : "";
      const parsedPath = triggerPathMatch
        ? triggerPathMatch
            .replace(/^\s+path:\s*/, "")
            .trim()
            .replace(/^"|"$/g, "")
            .replace(/^\/hooks\//, "")
        : "";

      // Parse steps: collect prompt strings from `- id: step-X` blocks under
      // the top-level `steps:` key. We don't pull a full YAML parser in just
      // for this — the AI generator emits a predictable shape.
      const parsedSteps: Step[] = [];
      const stepsIdx = lines.findIndex((l) => /^steps:\s*$/.test(l));
      if (stepsIdx >= 0) {
        let i = stepsIdx + 1;
        let current: Partial<Step> | null = null;
        // Multiline prompt buffer for `prompt: |` block scalars.
        let promptBuf: string[] | null = null;
        let promptBaseIndent = 0;
        const flush = () => {
          if (current && current.id) {
            parsedSteps.push({
              id: current.id,
              agent: current.agent ?? true,
              prompt: (current.prompt ?? "").trim(),
            });
          }
          current = null;
          promptBuf = null;
        };
        while (i < lines.length) {
          const raw = lines[i] ?? "";
          // Stop at a new top-level key (no leading space and ends with `:`).
          if (/^[a-zA-Z_]/.test(raw)) break;
          if (promptBuf) {
            const indent = raw.match(/^(\s*)/)?.[1].length ?? 0;
            if (raw.trim() === "" || indent > promptBaseIndent) {
              promptBuf.push(raw.slice(Math.min(promptBaseIndent + 2, indent)));
              i++;
              continue;
            }
            current = { ...current, prompt: promptBuf.join("\n").trim() };
            promptBuf = null;
            // fall through to handle this line as a new key
          }
          const itemMatch = raw.match(/^\s*-\s*id:\s*(.+?)\s*$/);
          if (itemMatch) {
            flush();
            current = { id: itemMatch[1]?.replace(/^"|"$/g, "") };
            i++;
            continue;
          }
          const kvMatch = raw.match(/^\s+([a-zA-Z_]+):\s*(.*)$/);
          if (kvMatch && current) {
            const key = kvMatch[1];
            const value = kvMatch[2]?.trim() ?? "";
            if (key === "agent") {
              current.agent = value === "true";
            } else if (key === "prompt") {
              if (value === "|" || value === ">" || value === "|-" || value === ">-") {
                promptBuf = [];
                promptBaseIndent =
                  (raw.match(/^(\s*)/)?.[1].length ?? 0);
              } else {
                current.prompt = value.replace(/^"|"$/g, "").replace(/^'|'$/g, "");
              }
            }
          }
          i++;
        }
        flush();
      }

      setForm((f) => ({
        ...f,
        name: parsedName || f.name,
        description: parsedDesc || f.description,
        trigger: {
          type: normalizedType,
          cron: parsedCron,
          path: parsedPath,
        },
        steps: parsedSteps.length > 0 ? parsedSteps : f.steps,
      }));
      setValidation((cur) => ({
        ...cur,
        steps:
          parsedSteps.length > 0
            ? parsedSteps.map(() => null)
            : cur.steps,
      }));
      setAiOpen(false);
      setAiResult(null);
    } catch {
      // If parsing fails, leave everything as-is — user can see the YAML
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);

    const nextValidation = validateForm(form);
    setValidation(nextValidation);

    if (!safeName || nameError) {
      setNameError(nameError ?? "Name is required.");
      return;
    }

    if (hasValidationErrors(nextValidation)) {
      return;
    }

    const content = buildRecipeYaml(form, safeName);

    setSaving(true);
    setSubmitNotice(null);
    try {
      const res = await fetch(
        apiPath(`/api/bridge/recipes/${encodeURIComponent(safeName)}`),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        },
      );
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        demo?: boolean;
      };
      if (res.ok && data.ok !== false) {
        if (data.demo) {
          setSubmitNotice(
            "Demo mode — recipe was not persisted. Disable demo mode to save real recipes.",
          );
        } else {
          router.push(`/recipes/${encodeURIComponent(safeName)}/edit`);
        }
      } else if (data.error === "Invalid recipe name") {
        setNameError(data.error);
      } else {
        setSubmitError(data.error ?? "Failed to save recipe.");
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>New recipe</h1>
          <div className="page-head-sub">
            Start with structured fields, save a YAML recipe draft, then continue in the source editor.
          </div>
        </div>
      </div>

      <div
        style={{
          border: "1px solid var(--border-default)",
          borderRadius: "var(--r-2)",
          marginBottom: "var(--s-4)",
          overflow: "hidden",
        }}
      >
        <button
          type="button"
          onClick={() => setAiOpen((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--s-2)",
            width: "100%",
            background: "var(--bg-2)",
            border: "none",
            borderBottom: aiOpen ? "1px solid var(--border-default)" : "none",
            color: "var(--fg-1)",
            cursor: "pointer",
            fontSize: "var(--fs-m)",
            fontWeight: 500,
            padding: "var(--s-3) var(--s-4)",
            textAlign: "left",
          }}
        >
          <span style={{ fontSize: "var(--fs-xl)" }}>{aiOpen ? "▾" : "▸"}</span>
          Generate with AI
          <span
            style={{
              background: "var(--accent)",
              borderRadius: 4,
              color: "var(--on-accent)",
              fontSize: "var(--fs-2xs)",
              fontWeight: 700,
              letterSpacing: "0.05em",
              padding: "1px 5px",
            }}
          >
            NEW
          </span>
        </button>

        {aiOpen && (
          <div
            style={{
              background: "var(--bg-1)",
              display: "flex",
              flexDirection: "column",
              gap: "var(--s-3)",
              padding: "var(--s-4)",
            }}
          >
            <p
              style={{
                color: "var(--fg-2)",
                fontSize: "var(--fs-m)",
                margin: 0,
              }}
            >
              Describe what you want in plain language and Claude will draft a
              recipe YAML for you.
            </p>
            <textarea
              rows={3}
              placeholder="e.g. every morning, summarize my GitHub notifications and email me a digest"
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              disabled={aiLoading}
              style={{
                background: "var(--bg-2)",
                border: "1px solid var(--border-default)",
                borderRadius: "var(--r-2)",
                color: "var(--fg-0)",
                fontSize: "var(--fs-m)",
                fontFamily: "var(--font-sans)",
                outline: "none",
                padding: "var(--s-2) var(--s-3)",
                resize: "vertical",
                width: "100%",
              }}
            />
            <div style={{ display: "flex", gap: "var(--s-2)" }}>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={aiLoading || !aiPrompt.trim()}
                style={{
                  background: "var(--accent)",
                  border: "none",
                  borderRadius: "var(--r-2)",
                  color: "var(--on-accent)",
                  cursor:
                    aiLoading || !aiPrompt.trim() ? "not-allowed" : "pointer",
                  fontSize: "var(--fs-m)",
                  fontWeight: 500,
                  opacity: aiLoading || !aiPrompt.trim() ? 0.6 : 1,
                  padding: "var(--s-2) var(--s-4)",
                }}
              >
                {aiLoading ? "Generating…" : "Generate"}
              </button>
            </div>

            {aiResult?.error && (
              <p
                style={{
                  background: "var(--err-soft)",
                  border: "1px solid var(--err)",
                  borderRadius: "var(--r-2)",
                  color: "var(--err)",
                  fontSize: "var(--fs-s)",
                  margin: 0,
                  padding: "var(--s-2) var(--s-3)",
                }}
              >
                {aiResult.error}
              </p>
            )}

            {aiResult?.warnings && aiResult.warnings.length > 0 && (
              <details style={{ fontSize: "var(--fs-s)" }}>
                <summary
                  style={{
                    color: "var(--warn)",
                    cursor: "pointer",
                  }}
                >
                  {aiResult.warnings.length} warning
                  {aiResult.warnings.length !== 1 ? "s" : ""}
                </summary>
                <ul
                  style={{
                    color: "var(--fg-2)",
                    marginTop: "var(--s-1)",
                    paddingLeft: "var(--s-4)",
                  }}
                >
                  {aiResult.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </details>
            )}

            {aiResult?.yaml && (
              <div
                style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}
              >
                <pre
                  style={{
                    background: "var(--bg-2)",
                    border: "1px solid var(--border-default)",
                    borderRadius: "var(--r-2)",
                    color: "var(--fg-0)",
                    fontSize: "var(--fs-s)",
                    fontFamily: "var(--font-mono)",
                    margin: 0,
                    maxHeight: 300,
                    overflow: "auto",
                    padding: "var(--s-3)",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {aiResult.yaml}
                </pre>
                <div style={{ display: "flex", gap: "var(--s-2)" }}>
                  <button
                    type="button"
                    onClick={() => applyAiYaml(aiResult.yaml!)}
                    style={{
                      background: "var(--accent)",
                      border: "none",
                      borderRadius: "var(--r-2)",
                      color: "var(--on-accent)",
                      cursor: "pointer",
                      fontSize: "var(--fs-m)",
                      fontWeight: 500,
                      padding: "var(--s-2) var(--s-4)",
                    }}
                  >
                    Use this
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAiResult(null);
                      setAiOpen(false);
                    }}
                    style={{
                      background: "var(--bg-2)",
                      border: "1px solid var(--border-default)",
                      borderRadius: "var(--r-2)",
                      color: "var(--fg-1)",
                      cursor: "pointer",
                      fontSize: "var(--fs-m)",
                      padding: "var(--s-2) var(--s-4)",
                    }}
                  >
                    Discard
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <form
        onSubmit={handleSubmit}
        style={{
          display: "grid",
          gridTemplateColumns: "1fr",
          gap: "var(--s-6)",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr",
            gap: "var(--s-6)",
          }}
          className="recipe-form-layout"
        >
          {/* LEFT: form fields */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--s-5)",
            }}
          >
            {/* Name */}
            <div>
              <label
                htmlFor="recipe-name"
                style={{
                  display: "block",
                  marginBottom: "var(--s-2)",
                  color: "var(--fg-1)",
                  fontSize: "var(--fs-m)",
                  fontWeight: 500,
                }}
              >
                Name <span style={{ color: "var(--err)" }}>*</span>
              </label>
              <input
                id="recipe-name"
                type="text"
                value={form.name}
                onChange={(e) => setName(e.target.value)}
                required
                placeholder="my-daily-report"
                style={{
                  width: "100%",
                  background: "var(--bg-2)",
                  border: `1px solid ${nameError ? "var(--err)" : "var(--border-default)"}`,
                  borderRadius: "var(--r-2)",
                  color: "var(--fg-0)",
                  fontSize: "var(--fs-base)",
                  padding: "var(--s-2) var(--s-3)",
                  outline: "none",
                  fontFamily: "var(--font-mono)",
                }}
              />
              {nameError && (
                <div
                  style={{
                    marginTop: "var(--s-1)",
                    fontSize: "var(--fs-s)",
                    color: "var(--err)",
                  }}
                >
                  {nameError}
                </div>
              )}
            </div>

            {/* Description */}
            <div>
              <label
                htmlFor="recipe-desc"
                style={{
                  display: "block",
                  marginBottom: "var(--s-2)",
                  color: "var(--fg-1)",
                  fontSize: "var(--fs-m)",
                  fontWeight: 500,
                }}
              >
                Description{" "}
                <span style={{ color: "var(--fg-3)", fontWeight: 400 }}>
                  (optional)
                </span>
              </label>
              <textarea
                id="recipe-desc"
                value={form.description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this recipe do?"
                rows={2}
                style={{
                  width: "100%",
                  background: "var(--bg-2)",
                  border: "1px solid var(--border-default)",
                  borderRadius: "var(--r-2)",
                  color: "var(--fg-0)",
                  fontSize: "var(--fs-base)",
                  padding: "var(--s-2) var(--s-3)",
                  outline: "none",
                  resize: "vertical",
                  fontFamily: "var(--font-sans)",
                }}
              />
            </div>

            {/* Trigger */}
            <div>
              <label
                htmlFor="recipe-trigger"
                style={{
                  display: "block",
                  marginBottom: "var(--s-2)",
                  color: "var(--fg-1)",
                  fontSize: "var(--fs-m)",
                  fontWeight: 500,
                }}
              >
                Trigger
              </label>
              <select
                id="recipe-trigger"
                value={form.trigger.type}
                onChange={(e) =>
                  setTriggerType(
                    e.target.value as "manual" | "webhook" | "schedule",
                  )
                }
                style={{
                  width: "100%",
                  background: "var(--bg-2)",
                  border: "1px solid var(--border-default)",
                  borderRadius: "var(--r-2)",
                  color: "var(--fg-0)",
                  fontSize: "var(--fs-base)",
                  padding: "var(--s-2) var(--s-3)",
                  outline: "none",
                  cursor: "pointer",
                }}
              >
                <option value="manual">Manual</option>
                <option value="webhook">Webhook</option>
                <option value="schedule">Schedule</option>
              </select>

              {form.trigger.type === "webhook" && (
                <div style={{ marginTop: "var(--s-3)" }}>
                  <label
                    htmlFor="recipe-hook-path"
                    style={{
                      display: "block",
                      marginBottom: "var(--s-2)",
                      fontSize: "var(--fs-s)",
                      color: "var(--fg-2)",
                    }}
                  >
                    Webhook path
                  </label>
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 0 }}
                  >
                    <span
                      style={{
                        background: "var(--bg-3)",
                        border: "1px solid var(--border-default)",
                        borderRight: "none",
                        borderRadius: "var(--r-2) 0 0 var(--r-2)",
                        padding: "var(--s-2) var(--s-3)",
                        fontSize: "var(--fs-m)",
                        color: "var(--fg-2)",
                        fontFamily: "var(--font-mono)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      /hooks/
                    </span>
                    <input
                      id="recipe-hook-path"
                      type="text"
                      value={form.trigger.path}
                      onChange={(e) => setTriggerPath(e.target.value)}
                      placeholder="my-recipe"
                      style={{
                        flex: 1,
                        background: "var(--bg-2)",
                        border: `1px solid ${validation.triggerPath ? "var(--err)" : "var(--border-default)"}`,
                        borderRadius: "0 var(--r-2) var(--r-2) 0",
                        color: "var(--fg-0)",
                        fontSize: "var(--fs-m)",
                        padding: "var(--s-2) var(--s-3)",
                        outline: "none",
                        fontFamily: "var(--font-mono)",
                      }}
                    />
                  </div>
                  {validation.triggerPath && (
                    <div
                      style={{
                        marginTop: "var(--s-1)",
                        fontSize: "var(--fs-s)",
                        color: "var(--err)",
                      }}
                    >
                      {validation.triggerPath}
                    </div>
                  )}
                </div>
              )}

              {form.trigger.type === "schedule" && (
                <div style={{ marginTop: "var(--s-3)" }}>
                  <label
                    htmlFor="recipe-cron"
                    style={{
                      display: "block",
                      marginBottom: "var(--s-2)",
                      fontSize: "var(--fs-s)",
                      color: "var(--fg-2)",
                    }}
                  >
                    Cron expression
                  </label>
                  <input
                    id="recipe-cron"
                    type="text"
                    value={form.trigger.cron}
                    onChange={(e) => setTriggerCron(e.target.value)}
                    placeholder="0 9 * * 1-5"
                    style={{
                      width: "100%",
                      background: "var(--bg-2)",
                      border: `1px solid ${validation.cron ? "var(--err)" : "var(--border-default)"}`,
                      borderRadius: "var(--r-2)",
                      color: "var(--fg-0)",
                      fontSize: "var(--fs-m)",
                      padding: "var(--s-2) var(--s-3)",
                      outline: "none",
                      fontFamily: "var(--font-mono)",
                    }}
                  />
                  {validation.cron && (
                    <div
                      style={{
                        marginTop: "var(--s-1)",
                        fontSize: "var(--fs-s)",
                        color: "var(--err)",
                      }}
                    >
                      {validation.cron}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Variables */}
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: "var(--s-3)",
                }}
              >
                <span
                  style={{ color: "var(--fg-1)", fontSize: "var(--fs-m)", fontWeight: 500 }}
                >
                  Variables{" "}
                  <span style={{ color: "var(--fg-3)", fontWeight: 400 }}>
                    (optional)
                  </span>
                </span>
                <button type="button" className="btn sm" onClick={addVar}>
                  + Add variable
                </button>
              </div>

              {form.vars.length === 0 && (
                <div
                  style={{
                    fontSize: "var(--fs-s)",
                    color: "var(--fg-3)",
                    padding: "var(--s-2) 0",
                  }}
                >
                  No variables. Add variables that callers must supply at run time (e.g. SENTRY_ISSUE_ID).
                </div>
              )}

              {form.vars.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--s-3)",
                  }}
                >
                  {form.vars.map((v, i) => (
                    <div
                      key={i}
                      style={{
                        background: "var(--bg-2)",
                        border: "1px solid var(--border-subtle)",
                        borderRadius: "var(--r-3)",
                        padding: "var(--s-3) var(--s-4)",
                        display: "flex",
                        flexDirection: "column",
                        gap: "var(--s-2)",
                      }}
                    >
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "1fr 2fr auto",
                          gap: "var(--s-2)",
                          alignItems: "center",
                        }}
                      >
                        <input
                          type="text"
                          value={v.name}
                          onChange={(e) => updateVar(i, "name", e.target.value)}
                          placeholder="VAR_NAME"
                          aria-label={`Variable ${i + 1} name`}
                          style={{
                            background: "var(--bg-1)",
                            border: `1px solid ${validation.vars[i] ? "var(--err)" : "var(--border-subtle)"}`,
                            borderRadius: "var(--r-2)",
                            color: "var(--fg-0)",
                            fontSize: "var(--fs-m)",
                            padding: "var(--s-2) var(--s-3)",
                            outline: "none",
                            fontFamily: "var(--font-mono)",
                          }}
                        />
                        <input
                          type="text"
                          value={v.description}
                          onChange={(e) =>
                            updateVar(i, "description", e.target.value)
                          }
                          placeholder="Description / hint"
                          aria-label={`Variable ${i + 1} description`}
                          style={{
                            background: "var(--bg-1)",
                            border: "1px solid var(--border-subtle)",
                            borderRadius: "var(--r-2)",
                            color: "var(--fg-0)",
                            fontSize: "var(--fs-m)",
                            padding: "var(--s-2) var(--s-3)",
                            outline: "none",
                            fontFamily: "var(--font-sans)",
                          }}
                        />
                        <button
                          type="button"
                          className="btn sm ghost"
                          onClick={() => removeVar(i)}
                          aria-label={`Remove variable ${i + 1}`}
                          style={{ color: "var(--err)", padding: "0 var(--s-2)" }}
                        >
                          &#x2715;
                        </button>
                      </div>
                      {validation.vars[i] && (
                        <div
                          style={{
                            fontSize: "var(--fs-s)",
                            color: "var(--err)",
                          }}
                        >
                          {validation.vars[i]}
                        </div>
                      )}
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "auto 1fr",
                          gap: "var(--s-3)",
                          alignItems: "center",
                        }}
                      >
                        <label
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "var(--s-2)",
                            fontSize: "var(--fs-s)",
                            color: "var(--fg-2)",
                            cursor: "pointer",
                            userSelect: "none",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={v.required}
                            onChange={(e) =>
                              updateVar(i, "required", e.target.checked)
                            }
                          />
                          Required
                        </label>
                        <input
                          type="text"
                          value={v.default}
                          onChange={(e) =>
                            updateVar(i, "default", e.target.value)
                          }
                          placeholder="Default value (optional)"
                          aria-label={`Variable ${i + 1} default`}
                          style={{
                            background: "var(--bg-1)",
                            border: "1px solid var(--border-subtle)",
                            borderRadius: "var(--r-2)",
                            color: "var(--fg-0)",
                            fontSize: "var(--fs-s)",
                            padding: "var(--s-1) var(--s-3)",
                            outline: "none",
                            fontFamily: "var(--font-mono)",
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Steps */}
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: "var(--s-3)",
                }}
              >
                <span
                  style={{
                    color: "var(--fg-1)",
                    fontSize: "var(--fs-m)",
                    fontWeight: 500,
                  }}
                >
                  Steps
                </span>
                <button type="button" className="btn sm" onClick={addStep}>
                  + Add step
                </button>
              </div>

              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--s-4)",
                }}
              >
                {form.steps.map((step, i) => (
                  <div
                    key={step.id}
                    style={{
                      background: "var(--bg-2)",
                      border: "1px solid var(--border-subtle)",
                      borderRadius: "var(--r-3)",
                      padding: "var(--s-3) var(--s-4)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        marginBottom: "var(--s-2)",
                        gap: "var(--s-2)",
                      }}
                    >
                      <label
                        htmlFor={`step-prompt-${i}`}
                        style={{
                          fontSize: "var(--fs-s)",
                          color: "var(--fg-2)",
                          fontWeight: 500,
                        }}
                      >
                        Step {i + 1} — Agent prompt
                      </label>
                      <div style={{ display: "flex", gap: "var(--s-1)" }}>
                        <button
                          type="button"
                          className="btn sm ghost"
                          disabled={i === 0}
                          onClick={() => moveStep(i, "up")}
                          aria-label={`Move step ${i + 1} up`}
                          style={{ padding: "0 var(--s-2)" }}
                        >
                          &#9650;
                        </button>
                        <button
                          type="button"
                          className="btn sm ghost"
                          disabled={i === form.steps.length - 1}
                          onClick={() => moveStep(i, "down")}
                          aria-label={`Move step ${i + 1} down`}
                          style={{ padding: "0 var(--s-2)" }}
                        >
                          &#9660;
                        </button>
                        <button
                          type="button"
                          className="btn sm ghost"
                          disabled={form.steps.length <= 1}
                          onClick={() => removeStep(i)}
                          aria-label={`Remove step ${i + 1}`}
                          style={{
                            padding: "0 var(--s-2)",
                            color: "var(--err)",
                          }}
                        >
                          &#x2715; Remove
                        </button>
                      </div>
                    </div>
                    <textarea
                      id={`step-prompt-${i}`}
                      value={step.prompt}
                      onChange={(e) => updateStep(i, e.target.value)}
                      placeholder="Describe what Claude should do in this step…"
                      rows={3}
                      style={{
                        width: "100%",
                        background: "var(--bg-1)",
                        border: `1px solid ${validation.steps[i] ? "var(--err)" : "var(--border-subtle)"}`,
                        borderRadius: "var(--r-2)",
                        color: "var(--fg-0)",
                        fontSize: "var(--fs-m)",
                        padding: "var(--s-2) var(--s-3)",
                        outline: "none",
                        resize: "vertical",
                        fontFamily: "var(--font-sans)",
                      }}
                    />
                    {validation.steps[i] && (
                      <div
                        style={{
                          marginTop: "var(--s-1)",
                          fontSize: "var(--fs-s)",
                          color: "var(--err)",
                        }}
                      >
                        {validation.steps[i]}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Actions */}
            {submitError && <div className="alert-err">{submitError}</div>}
            {submitNotice && (
              <div
                role="status"
                style={{
                  background: "var(--bg-2)",
                  border: "1px solid var(--border-default)",
                  borderRadius: "var(--r-2)",
                  color: "var(--fg-1)",
                  fontSize: "var(--fs-s)",
                  padding: "var(--s-2) var(--s-3)",
                }}
              >
                {submitNotice}
              </div>
            )}
            <div
              style={{
                display: "flex",
                gap: "var(--s-3)",
                alignItems: "center",
              }}
            >
              <button type="submit" className="btn" disabled={saving}>
                {saving ? "Creating…" : "Create YAML draft"}
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => router.push("/recipes")}
              >
                Cancel
              </button>
            </div>
          </div>

          {/* RIGHT: YAML preview */}
          <div>
            <div
              style={{
                fontSize: "var(--fs-s)",
                color: "var(--fg-2)",
                fontWeight: 500,
                marginBottom: "var(--s-2)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              YAML preview
            </div>
            <div
              style={{
                fontSize: "var(--fs-s)",
                color: "var(--fg-3)",
                marginBottom: "var(--s-2)",
              }}
            >
              Saving creates a <code>.yaml</code> recipe and opens it in the YAML editor.
            </div>
            <pre
              style={{
                background: "var(--bg-2)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--r-3)",
                padding: "var(--s-4)",
                fontSize: "var(--fs-s)",
                fontFamily: "var(--font-mono)",
                color: "var(--fg-1)",
                overflowX: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                margin: 0,
                minHeight: 200,
              }}
            >
              <code>{previewYaml}</code>
            </pre>
          </div>
        </div>
      </form>

      <style>{`
        @media (min-width: 900px) {
          .recipe-form-layout {
            grid-template-columns: 1fr 1fr !important;
          }
        }
      `}</style>
    </section>
  );
}
