"use client";
import React from "react";
import Link from "next/link";
import { useEffect, useState } from "react";

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
}

export default function RecipesPage() {
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [err, setErr] = useState<string>();
  const [unsupported, setUnsupported] = useState(false);
  const [running, setRunning] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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

  async function runRecipe(name: string) {
    setRunning((p) => ({ ...p, [name]: "running…" }));
    try {
      const res = await fetch("/api/bridge/recipes/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
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

  return (
    <section>
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
                            onClick={() => runRecipe(r.name)}
                          >
                            Run
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
