"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useMemo, useState } from "react";
import { apiPath } from "@/lib/api";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";

// Closed vocabulary of action-class domains a worker's `owns` field can
// name — mirrors src/workers/actionClass.ts's REVERSIBILITY_BY_DOMAIN keys
// (exposed there via knownActionDomains()). Kept in sync by hand, same
// convention as recipes/new's NAME_RE mirroring src/recipes/names.ts.
const KNOWN_DOMAINS = [
  "vcs-read",
  "vcs-local",
  "vcs-push",
  "vcs-remote",
  "vcs-merge",
  "fs-read",
  "fs-write",
  "issue-read",
  "issue",
  "deps-read",
  "messaging",
  "http",
  "shell",
  "ci",
  "other",
] as const;

const WORKER_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function normalizeWorkerId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface RecipeOption {
  name: string;
}

interface RecipesResponse {
  recipes: RecipeOption[];
}

interface WorkerLintIssue {
  level: "error" | "warning";
  message: string;
}

interface LintResult {
  ok: boolean;
  errors: WorkerLintIssue[];
  warnings: WorkerLintIssue[];
}

function buildWorkerYaml(form: {
  id: string;
  name: string;
  sector: string;
  recipe: string;
  responsibilities: string;
  owns: string[];
  autonomyCeiling: number;
}): string {
  const lines: string[] = [];
  lines.push(`id: ${form.id}`);
  lines.push(`name: ${JSON.stringify(form.name)}`);
  if (form.sector.trim()) lines.push(`sector: ${JSON.stringify(form.sector.trim())}`);
  if (form.recipe) lines.push(`recipe: ${form.recipe}`);
  const responsibilities = form.responsibilities
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean);
  if (responsibilities.length > 0) {
    lines.push("responsibilities:");
    for (const r of responsibilities) lines.push(`  - ${JSON.stringify(r)}`);
  }
  if (form.owns.length > 0) {
    lines.push("owns:");
    for (const o of form.owns) lines.push(`  - ${o}`);
  } else {
    lines.push("owns: []");
  }
  lines.push(`autonomyCeiling: ${form.autonomyCeiling}`);
  return `${lines.join("\n")}\n`;
}

const CEILING_HINTS: Record<number, string> = {
  0: "Never acts autonomously — every action needs sign-off. Safest starting point for an unproven worker.",
  1: "Reversible actions flow freely; anything compensable or irreversible still needs sign-off.",
  2: "Compensable actions (e.g. closing a PR) unlock automatically. Permissive, not conservative — use 1 instead if you want compensable actions gated too.",
  3: "Rarely meaningful on its own — most classes jump straight from gated to L4 (see reachableLevels in actionClass.ts).",
  4: "Full autonomy, including irreversible actions. Only appropriate once a worker has earned trust locally — do not ship a new worker at this ceiling.",
};

export default function NewWorkerPage() {
  return (
    <Suspense
      fallback={
        <div className="empty-state" role="status" aria-live="polite">
          <p>Loading worker editor…</p>
        </div>
      }
    >
      <NewWorkerPageInner />
    </Suspense>
  );
}

function NewWorkerPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [id, setId] = useState(searchParams.get("id") ?? "");
  const [idTouched, setIdTouched] = useState(false);
  const [name, setName] = useState(searchParams.get("name") ?? "");
  const [sector, setSector] = useState("");
  const [recipe, setRecipe] = useState(searchParams.get("recipe") ?? "");
  const [responsibilities, setResponsibilities] = useState("");
  const [owns, setOwns] = useState<string[]>([]);
  // Default to the most conservative ceiling — a fresh, unproven worker
  // should start tightly capped, not inherit the reference templates' 4.
  const [autonomyCeiling, setAutonomyCeiling] = useState(0);

  const [lintResult, setLintResult] = useState<LintResult | null>(null);
  const [linting, setLinting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  const { data: recipesData } = useBridgeFetch<RecipesResponse>("/api/bridge/recipes");
  const recipeOptions = useMemo(
    () => recipesData?.recipes?.map((r) => r.name).filter(Boolean) ?? [],
    [recipesData],
  );

  const idSlug = useMemo(() => normalizeWorkerId(id), [id]);
  const idError =
    idTouched && id.trim() && !WORKER_ID_RE.test(idSlug)
      ? "Id must produce a kebab-case slug starting with a letter or digit (max 64 chars)."
      : null;

  const yaml = useMemo(
    () =>
      buildWorkerYaml({
        id: idSlug || "unnamed-worker",
        name: name.trim() || "Unnamed Worker",
        sector,
        recipe,
        responsibilities,
        owns,
        autonomyCeiling,
      }),
    [idSlug, name, sector, recipe, responsibilities, owns, autonomyCeiling],
  );

  const toggleOwns = useCallback((domain: string) => {
    setOwns((prev) =>
      prev.includes(domain) ? prev.filter((d) => d !== domain) : [...prev, domain],
    );
  }, []);

  async function runLint(): Promise<LintResult | null> {
    setLinting(true);
    setLintResult(null);
    try {
      const res = await fetch(apiPath("/api/bridge/workers/lint"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: yaml }),
      });
      const result = (await res.json()) as LintResult;
      setLintResult(result);
      return result;
    } catch (e) {
      const result: LintResult = {
        ok: false,
        errors: [{ level: "error", message: e instanceof Error ? e.message : String(e) }],
        warnings: [],
      };
      setLintResult(result);
      return result;
    } finally {
      setLinting(false);
    }
  }

  async function handleSave() {
    setSaveError(null);
    setSaveNotice(null);
    if (!idSlug || !WORKER_ID_RE.test(idSlug)) {
      setIdTouched(true);
      setSaveError("Fix the worker id before saving.");
      return;
    }
    const lint = await runLint();
    if (!lint?.ok) {
      setSaveError("Resolve the lint errors below before saving.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(apiPath(`/api/bridge/workers/${encodeURIComponent(idSlug)}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: yaml }),
      });
      const result = (await res.json()) as { ok: boolean; error?: string; warnings?: string[] };
      if (!result.ok) {
        setSaveError(result.error ?? "Save failed.");
        return;
      }
      setSaveNotice("Worker saved.");
      router.push("/workers");
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "var(--s-4)" }}>
      <div className="page-head">
        <div>
          <h1 className="editorial-h1" style={{ margin: 0 }}>
            New <span className="accent">worker</span>
          </h1>
          <div className="editorial-sub">
            A worker is a named recipe identity with a trust-ramp autonomy gate — see{" "}
            <code className="mono">docs/worker-autonomy-policy-gate.md</code>.
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)", marginTop: "var(--s-4)" }}>
        {/* Step 1 — body recipe */}
        <section>
          <h2 style={{ fontSize: "var(--fs-l)", fontWeight: 600, margin: "0 0 var(--s-2)" }}>
            1. Body recipe
          </h2>
          <p style={{ fontSize: "var(--fs-s)", color: "var(--ink-3)", margin: "0 0 var(--s-2)" }}>
            The recipe that forms this worker&apos;s triggers + steps. Need a new one first?{" "}
            <Link href="/recipes/new">Create a recipe</Link>.
          </p>
          <select
            className="input"
            value={recipe}
            onChange={(e) => setRecipe(e.target.value)}
            aria-label="Body recipe"
          >
            <option value="">— none yet —</option>
            {recipeOptions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </section>

        {/* Step 2 — identity */}
        <section>
          <h2 style={{ fontSize: "var(--fs-l)", fontWeight: 600, margin: "0 0 var(--s-2)" }}>
            2. Identity
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
            <label>
              <div style={{ fontSize: "var(--fs-s)", marginBottom: 4 }}>Id (kebab-case)</div>
              <input
                className="input"
                value={id}
                onChange={(e) => setId(e.target.value)}
                onBlur={() => setIdTouched(true)}
                placeholder="e.g. pr-reviewer"
              />
              {idError && (
                <div style={{ color: "var(--err)", fontSize: "var(--fs-2xs)", marginTop: 4 }}>
                  {idError}
                </div>
              )}
            </label>
            <label>
              <div style={{ fontSize: "var(--fs-s)", marginBottom: 4 }}>Name</div>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. PR Reviewer"
              />
            </label>
            <label>
              <div style={{ fontSize: "var(--fs-s)", marginBottom: 4 }}>Sector (optional)</div>
              <input
                className="input"
                value={sector}
                onChange={(e) => setSector(e.target.value)}
                placeholder="e.g. engineering"
              />
            </label>
            <label>
              <div style={{ fontSize: "var(--fs-s)", marginBottom: 4 }}>
                Responsibilities (one per line, optional)
              </div>
              <textarea
                className="input"
                rows={3}
                value={responsibilities}
                onChange={(e) => setResponsibilities(e.target.value)}
              />
            </label>
          </div>
        </section>

        {/* Step 3 — owns */}
        <section>
          <h2 style={{ fontSize: "var(--fs-l)", fontWeight: 600, margin: "0 0 var(--s-2)" }}>
            3. Action-classes this worker owns
          </h2>
          <p style={{ fontSize: "var(--fs-s)", color: "var(--ink-3)", margin: "0 0 var(--s-2)" }}>
            Trust is earned per (worker × action-class) — competence on one class never transfers to
            another. Leave empty to start owning nothing (the worker is gated on everything).
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s-2)" }}>
            {KNOWN_DOMAINS.map((domain) => (
              <label
                key={domain}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 10px",
                  border: "1px solid var(--line-2)",
                  borderRadius: "var(--radius)",
                  fontSize: "var(--fs-s)",
                  cursor: "pointer",
                  background: owns.includes(domain) ? "var(--bg-2)" : undefined,
                }}
              >
                <input
                  type="checkbox"
                  checked={owns.includes(domain)}
                  onChange={() => toggleOwns(domain)}
                />
                {domain}
              </label>
            ))}
          </div>
        </section>

        {/* Step 4 — autonomy ceiling */}
        <section>
          <h2 style={{ fontSize: "var(--fs-l)", fontWeight: 600, margin: "0 0 var(--s-2)" }}>
            4. Autonomy ceiling
          </h2>
          <p style={{ fontSize: "var(--fs-s)", color: "var(--ink-3)", margin: "0 0 var(--s-2)" }}>
            A hard cap on the max ramp level this worker may EVER reach, independent of earned track
            record. The dial still shows <em>earned</em> level; the gate operates at
            min(earned, ceiling).
          </p>
          <select
            className="input"
            value={autonomyCeiling}
            onChange={(e) => setAutonomyCeiling(Number(e.target.value))}
            aria-label="Autonomy ceiling"
          >
            {[0, 1, 2, 3, 4].map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
          <div
            style={{
              fontSize: "var(--fs-2xs)",
              color: autonomyCeiling >= 4 ? "var(--err)" : "var(--ink-3)",
              marginTop: 4,
            }}
          >
            {CEILING_HINTS[autonomyCeiling]}
          </div>
        </section>

        {/* Preview + lint + save */}
        <section>
          <h2 style={{ fontSize: "var(--fs-l)", fontWeight: 600, margin: "0 0 var(--s-2)" }}>
            Preview
          </h2>
          <pre
            className="mono"
            style={{
              background: "var(--bg-2)",
              padding: "var(--s-3)",
              borderRadius: "var(--radius)",
              fontSize: "var(--fs-xs)",
              overflowX: "auto",
              whiteSpace: "pre",
            }}
          >
            {yaml}
          </pre>

          {lintResult && (
            <div style={{ marginTop: "var(--s-2)", display: "flex", flexDirection: "column", gap: 4 }}>
              {lintResult.errors.map((issue, i) => (
                <div key={`err-${i}`} style={{ color: "var(--err)", fontSize: "var(--fs-s)" }}>
                  ✗ {issue.message}
                </div>
              ))}
              {lintResult.warnings.map((issue, i) => (
                <div key={`warn-${i}`} style={{ color: "var(--warn)", fontSize: "var(--fs-s)" }}>
                  ⚠ {issue.message}
                </div>
              ))}
              {lintResult.ok && lintResult.warnings.length === 0 && (
                <div style={{ color: "var(--ok)", fontSize: "var(--fs-s)" }}>✓ Lint passed.</div>
              )}
            </div>
          )}

          {saveError && (
            <div style={{ color: "var(--err)", fontSize: "var(--fs-s)", marginTop: "var(--s-2)" }}>
              {saveError}
            </div>
          )}
          {saveNotice && (
            <div style={{ color: "var(--ok)", fontSize: "var(--fs-s)", marginTop: "var(--s-2)" }}>
              {saveNotice}
            </div>
          )}

          <div style={{ display: "flex", gap: "var(--s-2)", marginTop: "var(--s-3)" }}>
            <button type="button" className="btn sm" onClick={() => void runLint()} disabled={linting}>
              {linting ? "Linting…" : "Lint"}
            </button>
            <button
              type="button"
              className="btn sm primary"
              onClick={() => void handleSave()}
              disabled={saving}
            >
              {saving ? "Saving…" : "Create worker"}
            </button>
            <Link href="/workers" className="btn sm ghost" style={{ textDecoration: "none" }}>
              Cancel
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
