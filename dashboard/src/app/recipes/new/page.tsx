"use client";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

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

function makeStepId(index: number): string {
  return `step-${index + 1}`;
}

const NAME_RE = /^[a-z0-9][a-z0-9_\- ]{0,63}$/i;

export default function NewRecipePage() {
  const router = useRouter();

  const [form, setForm] = useState<FormState>({
    name: "",
    description: "",
    trigger: { type: "manual", path: "", cron: "" },
    steps: [{ id: "step-1", agent: true, prompt: "" }],
    vars: [],
  });
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const setName = useCallback((v: string) => {
    setForm((f) => ({ ...f, name: v }));
    if (v && !NAME_RE.test(v)) {
      setNameError(
        "Name must start with a letter or digit and contain only letters, digits, spaces, hyphens, or underscores (max 64 chars).",
      );
    } else {
      setNameError(null);
    }
  }, []);

  const setDescription = useCallback((v: string) => {
    setForm((f) => ({ ...f, description: v }));
  }, []);

  const setTriggerType = useCallback(
    (type: "manual" | "webhook" | "schedule") => {
      setForm((f) => ({ ...f, trigger: { ...f.trigger, type } }));
    },
    [],
  );

  const setTriggerPath = useCallback((path: string) => {
    setForm((f) => ({ ...f, trigger: { ...f.trigger, path } }));
  }, []);

  const setTriggerCron = useCallback((cron: string) => {
    setForm((f) => ({ ...f, trigger: { ...f.trigger, cron } }));
  }, []);

  const updateStep = useCallback((index: number, prompt: string) => {
    setForm((f) => {
      const steps = f.steps.map((s, i) => (i === index ? { ...s, prompt } : s));
      return { ...f, steps };
    });
  }, []);

  const addStep = useCallback(() => {
    setForm((f) => {
      const steps = [
        ...f.steps,
        { id: makeStepId(f.steps.length), agent: true, prompt: "" },
      ];
      return { ...f, steps };
    });
  }, []);

  const removeStep = useCallback((index: number) => {
    setForm((f) => {
      if (f.steps.length <= 1) return f;
      const steps = f.steps.filter((_, i) => i !== index);
      return { ...f, steps };
    });
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
  }, []);

  const addVar = useCallback(() => {
    setForm((f) => ({
      ...f,
      vars: [
        ...f.vars,
        { name: "", description: "", required: false, default: "" },
      ],
    }));
  }, []);

  const removeVar = useCallback((index: number) => {
    setForm((f) => ({
      ...f,
      vars: f.vars.filter((_, i) => i !== index),
    }));
  }, []);

  const updateVar = useCallback(
    (index: number, field: keyof RecipeVar, value: string | boolean) => {
      setForm((f) => ({
        ...f,
        vars: f.vars.map((v, i) =>
          i === index ? { ...v, [field]: value } : v,
        ),
      }));
    },
    [],
  );

  const previewJson = useMemo(() => {
    const safeName = form.name.toLowerCase().replace(/\s+/g, "-");
    const trigger: Record<string, string> = { type: form.trigger.type };
    if (form.trigger.type === "webhook" && form.trigger.path) {
      trigger.path = `/hooks/${form.trigger.path}`;
    }
    if (form.trigger.type === "schedule" && form.trigger.cron) {
      trigger.cron = form.trigger.cron;
    }
    const payload: Record<string, unknown> = {
      name: safeName || "(name)",
      ...(form.description ? { description: form.description } : {}),
      trigger,
      steps: form.steps.map((s, i) => ({
        id: s.id || makeStepId(i),
        agent: s.agent,
        prompt: s.prompt || "(empty)",
      })),
    };
    if (form.vars.length > 0) {
      payload.vars = form.vars.map((v) => ({
        name: v.name || "(name)",
        ...(v.description ? { description: v.description } : {}),
        ...(v.required ? { required: true } : {}),
        ...(v.default ? { default: v.default } : {}),
      }));
    }
    payload.createdAt = "<timestamp>";
    return JSON.stringify(payload, null, 2);
  }, [form]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);

    if (!form.name || nameError) {
      setNameError(nameError ?? "Name is required.");
      return;
    }

    const trigger: Record<string, string> = { type: form.trigger.type };
    if (form.trigger.type === "webhook" && form.trigger.path) {
      trigger.path = `/hooks/${form.trigger.path}`;
    }
    if (form.trigger.type === "schedule" && form.trigger.cron) {
      trigger.cron = form.trigger.cron;
    }

    const body: Record<string, unknown> = {
      name: form.name,
      ...(form.description ? { description: form.description } : {}),
      trigger,
      steps: form.steps.map((s, i) => ({
        id: s.id || makeStepId(i),
        agent: s.agent,
        prompt: s.prompt,
      })),
    };
    if (form.vars.length > 0) {
      body.vars = form.vars.map((v) => ({
        name: v.name,
        ...(v.description ? { description: v.description } : {}),
        ...(v.required ? { required: true } : {}),
        ...(v.default ? { default: v.default } : {}),
      }));
    }

    setSaving(true);
    try {
      const res = await fetch("/api/bridge/recipes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (data.ok) {
        router.push("/recipes");
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
            Author and save a new automation recipe.
          </div>
        </div>
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
                  fontSize: 13,
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
                  fontSize: 14,
                  padding: "var(--s-2) var(--s-3)",
                  outline: "none",
                  fontFamily: "var(--font-mono)",
                }}
              />
              {nameError && (
                <div
                  style={{
                    marginTop: "var(--s-1)",
                    fontSize: 12,
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
                  fontSize: 13,
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
                  fontSize: 14,
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
                  fontSize: 13,
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
                  fontSize: 14,
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
                      fontSize: 12,
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
                        fontSize: 13,
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
                        border: "1px solid var(--border-default)",
                        borderRadius: "0 var(--r-2) var(--r-2) 0",
                        color: "var(--fg-0)",
                        fontSize: 13,
                        padding: "var(--s-2) var(--s-3)",
                        outline: "none",
                        fontFamily: "var(--font-mono)",
                      }}
                    />
                  </div>
                </div>
              )}

              {form.trigger.type === "schedule" && (
                <div style={{ marginTop: "var(--s-3)" }}>
                  <label
                    htmlFor="recipe-cron"
                    style={{
                      display: "block",
                      marginBottom: "var(--s-2)",
                      fontSize: 12,
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
                      border: "1px solid var(--border-default)",
                      borderRadius: "var(--r-2)",
                      color: "var(--fg-0)",
                      fontSize: 13,
                      padding: "var(--s-2) var(--s-3)",
                      outline: "none",
                      fontFamily: "var(--font-mono)",
                    }}
                  />
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
                  style={{ color: "var(--fg-1)", fontSize: 13, fontWeight: 500 }}
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
                    fontSize: 12,
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
                            border: "1px solid var(--border-subtle)",
                            borderRadius: "var(--r-2)",
                            color: "var(--fg-0)",
                            fontSize: 13,
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
                            fontSize: 13,
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
                            fontSize: 12,
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
                            fontSize: 12,
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
                    fontSize: 13,
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
                          fontSize: 12,
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
                        border: "1px solid var(--border-subtle)",
                        borderRadius: "var(--r-2)",
                        color: "var(--fg-0)",
                        fontSize: 13,
                        padding: "var(--s-2) var(--s-3)",
                        outline: "none",
                        resize: "vertical",
                        fontFamily: "var(--font-sans)",
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Actions */}
            {submitError && <div className="alert-err">{submitError}</div>}
            <div
              style={{
                display: "flex",
                gap: "var(--s-3)",
                alignItems: "center",
              }}
            >
              <button type="submit" className="btn" disabled={saving}>
                {saving ? "Saving…" : "Save recipe"}
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

          {/* RIGHT: JSON preview */}
          <div>
            <div
              style={{
                fontSize: 12,
                color: "var(--fg-2)",
                fontWeight: 500,
                marginBottom: "var(--s-2)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              Preview
            </div>
            <pre
              style={{
                background: "var(--bg-2)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--r-3)",
                padding: "var(--s-4)",
                fontSize: 12,
                fontFamily: "var(--font-mono)",
                color: "var(--fg-1)",
                overflowX: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                margin: 0,
                minHeight: 200,
              }}
            >
              <code>{previewJson}</code>
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
