"use client";
import React from "react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const d = new Date(ms);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

interface RecipeVar {
  name: string;
  description?: string;
  required?: boolean;
  default?: string;
}

interface Recipe {
  id?: string;
  name: string;
  version?: string;
  description?: string;
  installedAt?: number;
  source?: string;
  trigger?: string;
  stepCount?: number;
  path?: string;
  hasPermissions?: boolean;
  vars?: RecipeVar[];
}

interface RunModalState {
  recipe: Recipe;
  values: Record<string, string>;
}

function RunModal({
  state,
  onClose,
  onConfirm,
  running,
}: {
  state: RunModalState;
  onClose: () => void;
  onConfirm: (vars: Record<string, string>) => void;
  running: boolean;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) onClose();
  }

  const vars = state.recipe.vars ?? [];

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--border-default)",
          borderRadius: "var(--r-3)",
          padding: "var(--s-6)",
          minWidth: 360,
          maxWidth: 480,
          width: "100%",
          boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "var(--s-4)",
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: 16,
              fontWeight: 600,
              color: "var(--fg-0)",
            }}
          >
            Run{" "}
            <code
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 14,
                background: "var(--bg-2)",
                padding: "1px 6px",
                borderRadius: "var(--r-1)",
              }}
            >
              {state.recipe.name}
            </code>
          </h2>
          <button
            type="button"
            className="btn sm ghost"
            onClick={onClose}
            aria-label="Close"
            style={{ padding: "0 var(--s-2)", fontSize: 16 }}
          >
            &#x2715;
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            onConfirm(state.values);
          }}
        >
          <div
            style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}
          >
            {vars.map((v) => (
              <div key={v.name}>
                <label
                  htmlFor={`run-var-${v.name}`}
                  style={{
                    display: "block",
                    marginBottom: "var(--s-1)",
                    fontSize: 13,
                    fontWeight: 500,
                    color: "var(--fg-1)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {v.name}
                  {v.required && (
                    <span style={{ color: "var(--err)", marginLeft: 4 }}>*</span>
                  )}
                </label>
                {v.description && (
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--fg-3)",
                      marginBottom: "var(--s-1)",
                    }}
                  >
                    {v.description}
                  </div>
                )}
                <input
                  id={`run-var-${v.name}`}
                  type="text"
                  required={v.required}
                  value={state.values[v.name] ?? ""}
                  placeholder={v.description ?? v.default ?? ""}
                  onChange={(e) => {
                    state.values[v.name] = e.target.value;
                    // trigger re-render via the parent's setter passed through onConfirm
                    // we update in-place here; parent re-renders on confirm
                  }}
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
            ))}
          </div>

          <div
            style={{
              display: "flex",
              gap: "var(--s-3)",
              marginTop: "var(--s-5)",
              justifyContent: "flex-end",
            }}
          >
            <button
              type="button"
              className="btn ghost"
              onClick={onClose}
              disabled={running}
            >
              Cancel
            </button>
            <button type="submit" className="btn" disabled={running}>
              {running ? "Starting…" : "Run recipe"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function RecipesPage() {
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [err, setErr] = useState<string>();
  const [unsupported, setUnsupported] = useState(false);
  const [running, setRunning] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<RunModalState | null>(null);
  const [modalRunning, setModalRunning] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/api/bridge/recipes");
        if (res.status === 404) {
          setUnsupported(true);
          setRecipes([]);
          return;
        }
        if (!res.ok) throw new Error(`/recipes ${res.status}`);
        const data = await res.json();
        const list: Recipe[] = Array.isArray(data)
          ? data
          : Array.isArray(data?.recipes)
            ? data.recipes
            : [];
        setRecipes(list);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    };
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  async function executeRun(name: string, vars?: Record<string, string>) {
    setRunning((p) => ({ ...p, [name]: "running…" }));
    try {
      const body: Record<string, unknown> = { name };
      if (vars && Object.keys(vars).length > 0) body.vars = vars;
      const res = await fetch("/api/bridge/recipes/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as {
        ok: boolean;
        taskId?: string;
        error?: string;
      };
      if (data.ok && data.taskId) {
        setRunning((p) => ({
          ...p,
          [name]: `queued ${data.taskId?.slice(0, 8)}`,
        }));
      } else {
        setRunning((p) => ({
          ...p,
          [name]: `error: ${data.error ?? "unknown"}`,
        }));
      }
    } catch (e) {
      setRunning((p) => ({
        ...p,
        [name]: `error: ${e instanceof Error ? e.message : String(e)}`,
      }));
    }
  }

  function handleRunClick(recipe: Recipe) {
    const vars = recipe.vars ?? [];
    if (vars.length === 0) {
      void executeRun(recipe.name);
      return;
    }
    // Pre-fill defaults
    const values: Record<string, string> = {};
    for (const v of vars) {
      values[v.name] = v.default ?? "";
    }
    setModal({ recipe, values });
    setModalRunning(false);
  }

  async function handleModalConfirm(vars: Record<string, string>) {
    if (!modal) return;
    const name = modal.recipe.name;
    setModalRunning(true);
    setModal(null);
    setModalRunning(false);
    await executeRun(name, vars);
  }

  return (
    <section>
      {modal && (
        <RunModal
          state={modal}
          onClose={() => setModal(null)}
          onConfirm={handleModalConfirm}
          running={modalRunning}
        />
      )}

      <div className="page-head">
        <div>
          <h1>Recipes</h1>
          <div className="page-head-sub">
            Installed automation recipes and their compiled programs.
          </div>
        </div>
        <div
          style={{ display: "flex", alignItems: "center", gap: "var(--s-3)" }}
        >
          {recipes && (
            <span className="pill muted">{recipes.length} installed</span>
          )}
          <Link href="/recipes/new" className="btn">
            New recipe
          </Link>
        </div>
      </div>

      {err && <div className="alert-err">Unreachable: {err}</div>}

      {recipes === null && !err ? (
        <div className="empty-state">
          <p>Loading…</p>
        </div>
      ) : recipes === null || recipes.length === 0 ? (
        <div className="empty-state">
          <h3>No recipes installed</h3>
          <p>
            Run <code>patchwork recipe install &lt;file&gt;</code> to add one.
          </p>
          {unsupported && (
            <p style={{ marginTop: 12, fontSize: 12 }}>
              Recipe listing endpoint not available on this bridge version.
            </p>
          )}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th style={{ width: 100 }}>Trigger</th>
                <th style={{ width: 70 }}>Steps</th>
                <th>Description</th>
                <th style={{ width: 220 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {recipes.map((r, i) => {
                const state = running[r.name];
                return (
                  <React.Fragment key={r.id ?? r.name ?? i}>
                    <tr>
                      <td className="mono">
                        <button
                          type="button"
                          style={{
                            background: "none",
                            border: "none",
                            padding: 0,
                            cursor: "pointer",
                            fontFamily: "inherit",
                            fontSize: "inherit",
                            color: "inherit",
                            userSelect: "none",
                            textAlign: "left",
                          }}
                          onClick={() =>
                            setExpanded((prev) => {
                              const next = new Set(prev);
                              next.has(r.name)
                                ? next.delete(r.name)
                                : next.add(r.name);
                              return next;
                            })
                          }
                        >
                          {expanded.has(r.name) ? "▾" : "▸"} {r.name}
                        </button>
                      </td>
                      <td>
                        <span className="pill muted">{r.trigger ?? "—"}</span>
                      </td>
                      <td className="mono muted">{r.stepCount ?? "—"}</td>
                      <td>
                        {r.description ?? <span className="muted">—</span>}
                      </td>
                      <td>
                        <div
                          style={{
                            display: "flex",
                            gap: 8,
                            alignItems: "center",
                          }}
                        >
                          <button
                            type="button"
                            className="btn"
                            onClick={() => handleRunClick(r)}
                          >
                            Run{r.vars && r.vars.length > 0 ? "…" : ""}
                          </button>
                          {state && (
                            <span
                              className="pill muted"
                              style={{ fontSize: 11 }}
                            >
                              {state}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                    {expanded.has(r.name) && (
                      <tr key={`${r.id ?? r.name ?? i}-detail`}>
                        <td
                          colSpan={5}
                          style={{
                            padding: "8px 16px 16px",
                            background: "var(--bg-2)",
                          }}
                        >
                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns:
                                "repeat(auto-fill, minmax(240px, 1fr))",
                              gap: "8px 24px",
                              fontSize: 12,
                            }}
                          >
                            <div>
                              <span className="muted">Path</span>
                              <br />
                              <code>{r.path ?? "—"}</code>
                            </div>
                            <div>
                              <span className="muted">Installed</span>
                              <br />
                              {r.installedAt !== undefined
                                ? relTime(r.installedAt)
                                : "—"}
                            </div>
                            <div>
                              <span className="muted">Source</span>
                              <br />
                              <span className="pill muted">
                                {r.source ?? "—"}
                              </span>
                            </div>
                            <div>
                              <span className="muted">Permissions</span>
                              <br />
                              {r.hasPermissions ? (
                                <span className="pill ok">✓ granted</span>
                              ) : (
                                <span className="pill muted">none</span>
                              )}
                            </div>
                            {r.vars && r.vars.length > 0 && (
                              <div style={{ gridColumn: "1 / -1" }}>
                                <span className="muted">Variables</span>
                                <br />
                                <div
                                  style={{
                                    display: "flex",
                                    flexWrap: "wrap",
                                    gap: "4px 8px",
                                    marginTop: 4,
                                  }}
                                >
                                  {r.vars.map((v) => (
                                    <span
                                      key={v.name}
                                      className="pill muted"
                                      style={{ fontFamily: "var(--font-mono)" }}
                                      title={v.description}
                                    >
                                      {v.name}
                                      {v.required ? (
                                        <span style={{ color: "var(--err)" }}>
                                          *
                                        </span>
                                      ) : null}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
