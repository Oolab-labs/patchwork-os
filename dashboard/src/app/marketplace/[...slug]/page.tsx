import Link from "next/link";
import { notFound } from "next/navigation";
import {
  fetchManifest,
  fetchRecipeYaml,
  fetchRegistry,
  githubBlobUrlFor,
  parseInstallSource,
  type RecipeManifest,
  type RegistryRecipe,
  shortName,
  summarizeRisk,
} from "@/lib/registry";
import InstallPanel from "./InstallPanel";

export const revalidate = 300;

interface PageProps {
  params: { slug: string[] };
}

export async function generateMetadata({ params }: PageProps) {
  const fullName = decodeURIComponent(params.slug.join("/"));
  return {
    title: `${shortName(fullName)} — Marketplace · Patchwork OS`,
  };
}

export default async function RecipeDetailPage({ params }: PageProps) {
  const fullName = decodeURIComponent(params.slug.join("/"));

  const registry = await fetchRegistry();
  const recipe = registry?.recipes.find((r) => r.name === fullName);
  if (!recipe) notFound();

  const src = parseInstallSource(recipe.install);
  let manifest: RecipeManifest | null = null;
  let yaml: string | null = null;
  if (src) {
    manifest = await fetchManifest(src);
    const main = manifest?.recipes?.main;
    if (main) yaml = await fetchRecipeYaml(src, main);
  }

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "var(--s-6)" }}>
      <Link
        href="/marketplace"
        className="btn sm ghost"
        style={{ alignSelf: "flex-start", textDecoration: "none", fontSize: 12 }}
      >
        ← Back to marketplace
      </Link>

      <Header recipe={recipe} manifest={manifest} />

      <Description recipe={recipe} manifest={manifest} />

      <InstallPanel install={recipe.install} name={recipe.name} />

      <Variables manifest={manifest} />

      <Steps yaml={yaml} />

      <YamlPreview yaml={yaml} src={src} mainFile={manifest?.recipes?.main} />

      <TrustNote />
    </section>
  );
}

// ----------------------------------------------------------------- subcomponents

function Header({
  recipe,
  manifest,
}: {
  recipe: RegistryRecipe;
  manifest: RecipeManifest | null;
}) {
  return (
    <div className="page-head">
      <div>
        <h1 style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)", letterSpacing: "-0.01em" }}>
          {shortName(recipe.name)}
        </h1>
        <div className="page-head-sub" style={{ fontSize: 13, color: "var(--ink-2)" }}>
          {recipe.name}
          <span style={{ margin: "0 8px", color: "var(--ink-3)" }}>·</span>
          <span>v{recipe.version}</span>
          {manifest?.author && (
            <>
              <span style={{ margin: "0 8px", color: "var(--ink-3)" }}>·</span>
              <span>by {manifest.author}</span>
            </>
          )}
          {manifest?.license && (
            <>
              <span style={{ margin: "0 8px", color: "var(--ink-3)" }}>·</span>
              <span>{manifest.license}</span>
            </>
          )}
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
        {recipe.tags.map((t) => (
          <span key={t} className="tag-pill">
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}

function Description({
  recipe,
  manifest,
}: {
  recipe: RegistryRecipe;
  manifest: RecipeManifest | null;
}) {
  const description = manifest?.description ?? recipe.description;
  return (
    <p style={{ fontSize: 14, color: "var(--ink-1)", lineHeight: 1.6, maxWidth: 760 }}>
      {description}
    </p>
  );
}

function Variables({ manifest }: { manifest: RecipeManifest | null }) {
  const vars = manifest?.variables;
  if (!vars || Object.keys(vars).length === 0) return null;

  const entries = Object.entries(vars);
  return (
    <div className="glass-card" style={{ padding: "var(--s-5)" }}>
      <h3 style={{ fontSize: 13, marginTop: 0, marginBottom: "var(--s-3)" }}>Configuration</h3>
      <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--ink-2)" }}>
            <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--line-1)" }}>Variable</th>
            <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--line-1)" }}>Required</th>
            <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--line-1)" }}>Default</th>
            <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--line-1)" }}>Description</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([key, info]) => (
            <tr key={key}>
              <td style={{ padding: "8px", fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
                {key}
              </td>
              <td style={{ padding: "8px", color: info.required ? "var(--accent-strong)" : "var(--ink-3)" }}>
                {info.required ? "yes" : "no"}
              </td>
              <td style={{ padding: "8px", fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
                {info.default ?? "—"}
              </td>
              <td style={{ padding: "8px", color: "var(--ink-2)" }}>{info.description ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Steps({ yaml }: { yaml: string | null }) {
  if (!yaml) return null;
  const r = summarizeRisk(yaml);
  if (r.steps === 0) return null;

  return (
    <div className="glass-card" style={{ padding: "var(--s-5)" }}>
      <h3 style={{ fontSize: 13, marginTop: 0, marginBottom: "var(--s-3)" }}>Steps & risk</h3>
      <div style={{ display: "flex", gap: 12, fontSize: 12, color: "var(--ink-1)" }}>
        <span>
          <strong>{r.steps}</strong> step{r.steps === 1 ? "" : "s"}
        </span>
        {r.low > 0 && (
          <span style={{ color: "var(--ok)" }}>
            <strong>{r.low}</strong> low risk
          </span>
        )}
        {r.medium > 0 && (
          <span style={{ color: "var(--warn)" }}>
            <strong>{r.medium}</strong> medium risk
          </span>
        )}
        {r.high > 0 && (
          <span style={{ color: "var(--err)" }}>
            <strong>{r.high}</strong> high risk
          </span>
        )}
      </div>
    </div>
  );
}

function YamlPreview({
  yaml,
  src,
  mainFile,
}: {
  yaml: string | null;
  src: ReturnType<typeof parseInstallSource>;
  mainFile: string | undefined;
}) {
  if (!yaml) {
    return (
      <div className="glass-card" style={{ padding: "var(--s-5)", color: "var(--ink-2)", fontSize: 13 }}>
        Recipe source unavailable.
      </div>
    );
  }
  return (
    <div className="glass-card" style={{ padding: 0, overflow: "hidden" }}>
      <div
        style={{
          padding: "10px 16px",
          borderBottom: "1px solid var(--line-1)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 12,
          color: "var(--ink-2)",
        }}
      >
        <span style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
          {mainFile ?? "recipe.yaml"}
        </span>
        {src && mainFile && (
          <a
            href={githubBlobUrlFor(src, mainFile)}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--accent-strong)", textDecoration: "none", fontSize: 11 }}
          >
            View on GitHub →
          </a>
        )}
      </div>
      <pre
        style={{
          margin: 0,
          padding: "16px",
          fontFamily: "var(--font-mono, ui-monospace, monospace)",
          fontSize: 12,
          lineHeight: 1.55,
          color: "var(--ink-1)",
          background: "var(--recess)",
          overflowX: "auto",
          whiteSpace: "pre",
        }}
      >
        {yaml}
      </pre>
    </div>
  );
}

function TrustNote() {
  return (
    <div
      style={{
        padding: "12px 16px",
        background: "rgba(180,83,9,0.06)",
        border: "1px solid rgba(180,83,9,0.18)",
        borderRadius: "var(--r-3)",
        fontSize: 12,
        color: "var(--ink-2)",
        lineHeight: 1.6,
      }}
    >
      <strong style={{ color: "var(--ink-0)" }}>Trust note.</strong> Marketplace recipes are open-source
      community contributions and are not signature-verified. Patchwork OS installs every recipe in a
      <em> disabled </em>state and gates each write through the approval inbox before it leaves your
      machine. Review the YAML above before enabling.
    </div>
  );
}
