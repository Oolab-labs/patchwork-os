"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useMemo, useRef, useState } from "react";
import { apiPath } from "@/lib/api";
import { normalizeRecipeName, prepareAndSaveAiRecipe } from "./applyAiYaml";

interface Step {
  id: string;
  agent: boolean;
  prompt: string;
  // When present, used verbatim instead of deriving from `id` via
  // `makeStepOutputKey`. Lets us preserve the AI generator's semantic
  // `into:` keys (e.g. `notifications_summary`) so step→step references
  // like `{{notifications_summary}}` keep resolving.
  into?: string;
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

  if (form.trigger.type === "schedule") {
    const at = form.trigger.cron.trim();
    if (!at) {
      errors.cron = "Cron expression is required.";
    } else if (
      !/^@every\s+\d+\s*(ms|s|m|h)$/i.test(at) &&
      !/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(at)
    ) {
      // Cheap shape check — server runs node-cron's full validator. Catches
      // obvious typos ("bogus", 3-field, 6-field) without pulling node-cron
      // into the bundle.
      errors.cron =
        'Expected 5-field cron (e.g. "0 9 * * 1-5") or "@every Ns|Nm|Nh".';
    }
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
    if (!VAR_NAME_RE.test(name)) {
      // Mirror the runtime template-reference regex
      // (src/recipes/validation.ts: extractTemplateDottedPaths). Names that
      // can't match `{{...}}` will silently never resolve at runtime —
      // reject them at save time instead.
      errors.vars[i] =
        "Variable name must start with a letter or underscore, then letters, digits, or underscores only.";
      continue;
    }
    if (RESERVED_VAR_NAMES.has(name.toLowerCase())) {
      // Case-insensitive — VAR_NAME_RE admits `DATE`/`Date`. Treat them
      // the same as `date` to match the server-side gate.
      errors.vars[i] = `'${name}' is a reserved built-in context key.`;
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

// Mirrors the runtime template-reference regex root group in
// src/recipes/validation.ts:extractTemplateDottedPaths. Var names that
// don't match this can never resolve as `{{name}}` at runtime — silently
// rendering as empty string. Reject at save time.
const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

// Built-in context keys reserved by the runtime — declaring a var with
// any of these names would shadow trigger-emitted data silently. The
// list is the simple-identifier subset from registerRecipeContextKeys
// + extractTemplateExpressions builtinKeys (src/recipes/validation.ts).
const RESERVED_VAR_NAMES = new Set([
  "date",
  "time",
  "YYYY",
  "ISO_NOW",
  "HH",
  "MM",
  "SS",
  "this",
  "hash",
  "message",
  "branch",
  "payload",
  "webhook_payload",
  "hook_path",
  "webhook_path",
  "file",
  "file_ext",
  "file_basename",
  "runner",
  "failed",
  "passed",
  "total",
  "failures",
  "event",
]);

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

  // vars nest under trigger — validator (src/recipes/validation.ts) only
  // reads trigger.vars when building available template-ref roots; a
  // top-level `vars:` is not in schemas/recipe.v1.json.
  if (form.vars.length > 0) {
    lines.push("  vars:");
    for (const variable of form.vars) {
      lines.push(`    - name: ${yamlScalar(variable.name.trim() || "(name)")}`);
      if (variable.description.trim()) {
        pushYamlField(lines, 6, "description", variable.description.trim());
      }
      if (variable.required) {
        lines.push("      required: true");
      }
      if (variable.default) {
        pushYamlField(lines, 6, "default", variable.default);
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
    // Preserve a parsed `into:` (e.g. from AI-generated YAML) verbatim;
    // otherwise derive a slug from the step id. This keeps semantic keys
    // like `notifications_summary` intact across the form round-trip.
    const intoKey = step?.into?.trim() || makeStepOutputKey(stepId);
    lines.push(`      into: ${yamlScalar(intoKey)}`);
  }

  return lines.join("\n");
}

// Loose form-side check that mirrors the canonical server regex AFTER
// `normalizeRecipeName` runs. We accept uppercase/spaces/underscores in
// the input so users can type naturally; the slug shown in the YAML
// preview and used for the file path is the normalized form. The error
// only fires when normalization can't produce a valid slug at all
// (empty, leading dash, too long, or non-letter/digit chars left over).
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

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
  const [aiSaving, setAiSaving] = useState(false);
  const [aiResult, setAiResult] = useState<{
    yaml?: string;
    warnings?: string[];
    error?: string;
  } | null>(null);

  // Refs used to focus newly-appended rows on mount.
  // Keys are list indexes; the matching ref callback consumes pendingFocus when it attaches.
  const varNameRefs = useRef<Map<number, HTMLInputElement | null>>(new Map());
  const stepPromptRefs = useRef<Map<number, HTMLTextAreaElement | null>>(new Map());
  const pendingFocus = useRef<{ kind: "var" | "step"; index: number } | null>(
    null,
  );

  const setName = useCallback((v: string) => {
    setForm((f) => ({ ...f, name: v }));
    // Validate the *slug* (after normalization), not the raw input.
    // Users may type "My Recipe" and that's fine — the form will save
    // it as `my-recipe.yaml`. Only reject if the normalized result
    // can't satisfy the canonical kebab-case rule.
    const slug = normalizeRecipeName(v);
    if (v.trim() && !NAME_RE.test(slug)) {
      setNameError(
        "Name must produce a slug starting with a letter or digit and containing only letters, digits, or hyphens (max 64 chars).",
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
      pendingFocus.current = { kind: "step", index: steps.length - 1 };
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
    setForm((f) => {
      const vars = [
        ...f.vars,
        { name: "", description: "", required: false, default: "" },
      ];
      pendingFocus.current = { kind: "var", index: vars.length - 1 };
      return { ...f, vars };
    });
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

  async function applyAiYaml(yamlText: string) {
    setAiSaving(true);
    try {
      const result = await prepareAndSaveAiRecipe(yamlText);
      if (!result.ok) {
        setAiResult((cur) => (cur ? { ...cur, error: result.error } : cur));
        return;
      }
      if (result.warnings) {
        try {
          sessionStorage.setItem(
            `recipe-save-warnings:${result.recipeName}`,
            JSON.stringify(result.warnings),
          );
        } catch {
          // sessionStorage unavailable — non-fatal; edit page re-lints.
        }
      }
      router.push(`/recipes/${encodeURIComponent(result.recipeName)}/edit`);
    } finally {
      setAiSaving(false);
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
        warnings?: string[];
      };
      if (res.ok && data.ok !== false) {
        if (data.demo) {
          setSubmitNotice(
            "Demo mode — recipe was not persisted. Disable demo mode to save real recipes.",
          );
        } else if (data.warnings && data.warnings.length > 0) {
          // Forward warnings to the edit page via sessionStorage so the
          // user sees them on first paint there. The edit page does its
          // own lint pass on mount, but that runs ~400ms after content
          // settles and uses different copy — handing off here avoids a
          // confusing flash.
          try {
            sessionStorage.setItem(
              `recipe-save-warnings:${safeName}`,
              JSON.stringify(data.warnings),
            );
          } catch {
            // sessionStorage unavailable — non-fatal, edit page will
            // re-derive warnings on its own lint pass.
          }
          router.push(`/recipes/${encodeURIComponent(safeName)}/edit`);
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

      {/*
        Scope banner — the structured form covers the common case (agent
        steps with manual/webhook/cron triggers). The schema also supports
        `tool:` steps, `recipe:`/`chain:` nested recipes, `parallel:` groups,
        and `file_watch`/`git_hook`/`on_file_save`/`on_test_run`/`chained`
        triggers. None of those have UI here yet — production recipes that
        use them (morning-brief, branch-health, etc.) are authored in the
        YAML editor directly. This banner tells the user that's the path
        rather than letting them assume the form is exhaustive.
      */}
      <div
        role="note"
        style={{
          background: "var(--bg-2)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--r-2)",
          color: "var(--fg-2)",
          fontSize: "var(--fs-s)",
          marginBottom: "var(--s-4)",
          padding: "var(--s-3) var(--s-4)",
        }}
      >
        <strong style={{ color: "var(--fg-1)" }}>Form scope:</strong> agent
        steps with manual, webhook, or schedule triggers. For advanced shapes
        — <code>tool:</code> steps, <code>parallel:</code> groups, nested
        recipes, or file-watch / git-hook / test-run triggers — save a stub
        here and continue in the YAML editor, or use{" "}
        <strong>Generate with AI</strong> below.
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
          <span style={{ fontSize: "var(--fs-xl)", color: "var(--ink-2)" }}>{aiOpen ? "▾" : "▸"}</span>
          Generate with AI
          <span
            style={{
              background: "var(--info)",
              borderRadius: 4,
              color: "#fff",
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
              placeholder="e.g. every weekday at 9am, summarize my unread Gmail and post the digest to Slack"
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
                    disabled={aiSaving}
                    style={{
                      background: "var(--accent)",
                      border: "none",
                      borderRadius: "var(--r-2)",
                      color: "var(--on-accent)",
                      cursor: aiSaving ? "not-allowed" : "pointer",
                      fontSize: "var(--fs-m)",
                      fontWeight: 500,
                      opacity: aiSaving ? 0.6 : 1,
                      padding: "var(--s-2) var(--s-4)",
                    }}
                  >
                    {aiSaving ? "Saving…" : "Save and edit"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAiResult(null);
                      setAiOpen(false);
                    }}
                    disabled={aiSaving}
                    style={{
                      background: "var(--bg-2)",
                      border: "1px solid var(--border-default)",
                      borderRadius: "var(--r-2)",
                      color: "var(--fg-1)",
                      cursor: aiSaving ? "not-allowed" : "pointer",
                      fontSize: "var(--fs-m)",
                      opacity: aiSaving ? 0.6 : 1,
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
                          ref={(node) => {
                            if (node) varNameRefs.current.set(i, node);
                            else varNameRefs.current.delete(i);
                            const target = pendingFocus.current;
                            if (
                              node &&
                              target &&
                              target.kind === "var" &&
                              target.index === i
                            ) {
                              pendingFocus.current = null;
                              node.focus();
                            }
                          }}
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
                      ref={(node) => {
                        if (node) stepPromptRefs.current.set(i, node);
                        else stepPromptRefs.current.delete(i);
                        const target = pendingFocus.current;
                        if (
                          node &&
                          target &&
                          target.kind === "step" &&
                          target.index === i
                        ) {
                          pendingFocus.current = null;
                          node.focus();
                        }
                      }}
                      id={`step-prompt-${i}`}
                      value={step.prompt}
                      onChange={(e) => updateStep(i, e.target.value)}
                      placeholder="Describe what Claude should do in this step…"
                      aria-label={`Step ${i + 1} prompt`}
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
