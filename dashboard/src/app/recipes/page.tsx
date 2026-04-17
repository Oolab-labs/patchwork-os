"use client";
import { useEffect, useState } from "react";

interface Recipe {
  id?: string;
  name: string;
  version?: string;
  description?: string;
  installedAt?: number;
  source?: string;
}

export default function RecipesPage() {
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [err, setErr] = useState<string>();
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    (async () => {
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
    })();
  }, []);

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
                <th style={{ width: 100 }}>Version</th>
                <th>Description</th>
                <th style={{ width: 160 }}>Source</th>
              </tr>
            </thead>
            <tbody>
              {recipes.map((r, i) => (
                <tr key={r.id ?? r.name ?? i}>
                  <td className="mono">{r.name}</td>
                  <td className="mono muted">{r.version ?? "—"}</td>
                  <td>{r.description ?? <span className="muted">—</span>}</td>
                  <td className="mono muted">{r.source ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
