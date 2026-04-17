"use client";
import { useEffect, useState } from "react";

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
        setRunning((p) => ({ ...p, [name]: `queued ${data.taskId!.slice(0, 8)}` }));
      } else {
        setRunning((p) => ({ ...p, [name]: `error: ${data.error ?? "unknown"}` }));
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
        {recipes && (
          <span className="pill muted">{recipes.length} installed</span>
        )}
      </div>

      {err && <div className="alert-err">Unreachable: {err}</div>}

      {recipes === null && !err ? (
        <div className="empty-state">
          <p>Loading…</p>
        </div>
      ) : recipes.length === 0 ? (
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
                  <tr key={r.id ?? r.name ?? i}>
                    <td className="mono">{r.name}</td>
                    <td>
                      <span className="pill muted">{r.trigger ?? "—"}</span>
                    </td>
                    <td className="mono muted">{r.stepCount ?? "—"}</td>
                    <td>{r.description ?? <span className="muted">—</span>}</td>
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
                          <span className="pill muted" style={{ fontSize: 11 }}>
                            {state}
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
