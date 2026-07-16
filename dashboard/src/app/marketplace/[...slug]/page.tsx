import Link from "next/link";
import { notFound } from "next/navigation";
import { ConnectorHealthPanel } from "@/components/ConnectorHealthPanel";
import {
  fetchManifest,
  fetchRecipeYaml,
  fetchRegistry,
  githubBlobUrlFor,
  parseInstallSource,
  type ApprovalBehavior,
  type RecipeManifest,
  type RegistryRecipe,
  type RiskLevel,
  shortName,
  summarizeRisk,
} from "@/lib/registry";
import {
  detectTrustDivergence,
  TrustDivergenceNotice,
} from "../_components/TrustDivergenceNotice";
import InstallPanel from "./InstallPanel";

// 60s ISR (was 300s). A 5-minute cache hides freshly merged recipes
// from the dashboard for an awkwardly long window after the registry
// PR lands — the audit flagged this as the longest-tail user-visible
// staleness in the marketplace flow. 60s keeps the CDN benefit
// (single fetch per minute per recipe slug) without the "merged 4
// minutes ago but still 404" surprise.
export const revalidate = 60;

// Next's per-fetch data cache (the `next: { revalidate }` option each
// fetchGithubFile() call sets) is a SEPARATE cache from the route
// segment's ISR `revalidate` above — matching the constant here doesn't
// happen automatically. Without this, fetchRegistry/fetchManifest/
// fetchRecipeYaml below fell back to fetchGithubFile's own 300s default,
// so the route segment could re-render every 60s while still being
// served a manifest/YAML fetch cached for up to 5x longer — quietly
// undercutting the very freshness this page's revalidate=60 change was
// written to guarantee, and specifically weakening the trust-divergence
// gate (#1185/#1186) that depends on fetching the CURRENT YAML.
const FETCH_OPTS = { revalidate };

interface PageProps {
  // Next 15: dynamic route params are Promise-typed.
  params: Promise<{ slug: string[] }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params;
  const fullName = decodeURIComponent(slug.join("/"));
  const registry = await fetchRegistry(FETCH_OPTS);
  // Don't mislabel a registry-down page as 404 — separate title makes
  // tab-history and SEO crawlers distinguish the two states.
  if (!registry) {
    return { title: "Registry unreachable — Marketplace · Patchwork OS" };
  }
  const recipe = registry.recipes.find((r) => r.name === fullName);
  if (!recipe) {
    return { title: "Not found — Marketplace · Patchwork OS" };
  }

  const title = `${shortName(recipe.name)} — Marketplace · Patchwork OS`;
  return {
    title,
    description: recipe.description,
    openGraph: {
      title: shortName(recipe.name),
      description: recipe.description,
      type: "article",
      tags: recipe.tags,
    },
    twitter: {
      card: "summary",
      title: shortName(recipe.name),
      description: recipe.description,
    },
  };
}

export default async function RecipeDetailPage({ params }: PageProps) {
  const { slug } = await params;
  const fullName = decodeURIComponent(slug.join("/"));

  const registry = await fetchRegistry(FETCH_OPTS);
  // Distinguish "registry unreachable" (CDN failure, transient network
  // issue) from "recipe genuinely missing" — pre-fix both collapsed into
  // notFound(), so every detail-page URL 404'd whenever the CDN was down.
  // Now the unreachable case renders a recoverable error UI with a
  // back-link instead of a hard 404 the user can't recover from.
  if (!registry) return <RegistryUnreachable fullName={fullName} />;
  const recipe = registry.recipes.find((r) => r.name === fullName);
  if (!recipe) notFound();

  const src = parseInstallSource(recipe.install);
  let manifest: RecipeManifest | null = null;
  let yaml: string | null = null;
  // Network failures on the CDN are not page-level errors — render the
  // detail page in a degraded state (description + install source) rather
  // than throwing a 500 the user can't recover from.
  if (src) {
    try {
      manifest = await fetchManifest(src, FETCH_OPTS);
    } catch {
      manifest = null;
    }
    const main = manifest?.recipes?.main;
    if (main) {
      try {
        yaml = await fetchRecipeYaml(src, main, FETCH_OPTS);
      } catch {
        yaml = null;
      }
    }
  }

  // Computed once and shared by InstallPanel's elevated-confirm gate and
  // TrustDivergenceNotice's warning banner, so they can never disagree.
  // Pre-fix, InstallPanel's one-click-vs-confirm decision only looked at
  // the registry's self-reported (community-maintained, unsigned)
  // risk_level/network_access/file_access — a recipe whose actual YAML
  // contradicted that metadata (declared low-risk but the fetched YAML has
  // high-risk file/network steps) still got a bare one-click Install
  // button; the divergence warning rendered further down the page only
  // AFTER the button the user had already clicked.
  const divergenceMeta = {
    risk_level: recipe.risk_level,
    network_access: recipe.network_access,
    file_access: recipe.file_access,
  };
  const riskSummary = yaml
    ? summarizeRisk(yaml)
    : { low: 0, medium: 0, high: 0, steps: 0 };
  const trustDivergence = detectTrustDivergence(divergenceMeta, riskSummary);

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "var(--s-6)" }}>
      <Link
        href="/marketplace"
        className="btn sm ghost"
        style={{ alignSelf: "flex-start", textDecoration: "none", fontSize: "var(--fs-s)" }}
      >
        ← Back to marketplace
      </Link>

      <Header recipe={recipe} manifest={manifest} />

      <Description recipe={recipe} manifest={manifest} />

      <InstallPanel
        install={recipe.install}
        name={recipe.name}
        riskLevel={recipe.risk_level}
        connectors={recipe.connectors}
        networkAccess={recipe.network_access}
        fileAccess={recipe.file_access}
        hasTrustDivergence={trustDivergence.length > 0}
      />

      <ConnectorHealthPanel connectors={recipe.connectors} marginTop={0} />

      <Variables manifest={manifest} />

      <Steps yaml={yaml} />

      <TrustMetadataCard recipe={recipe} />

      <TrustDivergenceNotice
        meta={divergenceMeta}
        riskSummary={riskSummary}
      />

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
        <div className="page-head-sub" style={{ fontSize: "var(--fs-m)", color: "var(--ink-2)" }}>
          {recipe.name}
          <span style={{ margin: "0 8px", color: "var(--ink-3)" }}>·</span>
          <span>v{recipe.version}</span>
          {(manifest?.author ?? recipe.maintainer) && (
            <>
              <span style={{ margin: "0 8px", color: "var(--ink-3)" }}>·</span>
              <span>by {manifest?.author ?? recipe.maintainer}</span>
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
    <p style={{ fontSize: "var(--fs-base)", color: "var(--ink-1)", lineHeight: 1.6, maxWidth: 760 }}>
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
      <h3 style={{ fontSize: "var(--fs-m)", marginTop: 0, marginBottom: "var(--s-3)" }}>Configuration</h3>
      {/* Horizontal scroll wrapper — table has 4 columns + variable-width
          description content, overflows at 375 px without this guard. */}
      <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
      <table style={{ width: "100%", fontSize: "var(--fs-s)", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--ink-2)" }}>
            <th scope="col" style={{ padding: "6px 8px", borderBottom: "1px solid var(--line-1)", textAlign: "left" }}>Variable</th>
            <th scope="col" style={{ padding: "6px 8px", borderBottom: "1px solid var(--line-1)", textAlign: "left" }}>Required</th>
            <th scope="col" style={{ padding: "6px 8px", borderBottom: "1px solid var(--line-1)", textAlign: "left" }}>Default</th>
            <th scope="col" style={{ padding: "6px 8px", borderBottom: "1px solid var(--line-1)", textAlign: "left" }}>Description</th>
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
    </div>
  );
}

function Steps({ yaml }: { yaml: string | null }) {
  if (!yaml) return null;
  const r = summarizeRisk(yaml);
  if (r.steps === 0) return null;

  return (
    <div className="glass-card" style={{ padding: "var(--s-5)" }}>
      <h3 style={{ fontSize: "var(--fs-m)", marginTop: 0, marginBottom: "var(--s-3)" }}>Steps & risk</h3>
      <div style={{ display: "flex", gap: 12, fontSize: "var(--fs-s)", color: "var(--ink-1)" }}>
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
      <div className="glass-card" style={{ padding: "var(--s-5)", color: "var(--ink-2)", fontSize: "var(--fs-m)" }}>
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
          fontSize: "var(--fs-s)",
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
            style={{ color: "var(--accent-strong)", textDecoration: "none", fontSize: "var(--fs-xs)" }}
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
          fontSize: "var(--fs-s)",
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

const RISK_PILL_CLASS: Record<RiskLevel, string> = { low: "ok", medium: "warn", high: "err" };
const APPROVAL_LABEL: Record<ApprovalBehavior, string> = {
  always_ask: "Always asks for approval",
  ask_on_novel: "Asks on new tools / specifiers",
  auto_approve: "Designed to run unattended once trusted",
};

function TrustMetadataCard({ recipe }: { recipe: RegistryRecipe }) {
  const { risk_level, network_access, file_access, approval_behavior, maintainer } = recipe;
  const hasAny = risk_level || network_access != null || file_access != null || approval_behavior || maintainer;
  if (!hasAny) return null;

  const rows: Array<{ label: string; value: React.ReactNode }> = [];
  if (risk_level) {
    rows.push({
      label: "Risk level",
      value: (
        <span className={`pill ${RISK_PILL_CLASS[risk_level]}`} style={{ fontSize: "var(--fs-xs)" }}>
          {risk_level}
        </span>
      ),
    });
  }
  if (approval_behavior) {
    rows.push({ label: "Approval", value: APPROVAL_LABEL[approval_behavior] });
  }
  if (network_access != null) {
    rows.push({ label: "Network access", value: network_access ? "Yes — makes outbound HTTP requests" : "No" });
  }
  if (file_access != null) {
    rows.push({ label: "File access", value: file_access ? "Yes — reads or writes local files" : "No" });
  }
  if (maintainer) {
    rows.push({ label: "Maintainer", value: maintainer });
  }

  return (
    <div className="glass-card" style={{ padding: "var(--s-5)" }}>
      <h3 style={{ fontSize: "var(--fs-m)", marginTop: 0, marginBottom: "var(--s-3)" }}>Trust &amp; permissions</h3>
      <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
      <table style={{ width: "100%", fontSize: "var(--fs-s)", borderCollapse: "collapse" }}>
        <tbody>
          {rows.map(({ label, value }) => (
            <tr key={label} style={{ borderBottom: "1px solid var(--line-1)" }}>
              <td style={{ padding: "7px 8px", color: "var(--ink-2)", width: 160, verticalAlign: "middle" }}>{label}</td>
              <td style={{ padding: "7px 8px", color: "var(--ink-1)", verticalAlign: "middle" }}>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

function RegistryUnreachable({ fullName }: { fullName: string }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "var(--s-5)" }}>
      <Link
        href="/marketplace"
        className="btn sm ghost"
        style={{ alignSelf: "flex-start", textDecoration: "none", fontSize: "var(--fs-s)" }}
      >
        ← Back to marketplace
      </Link>
      <div
        className="glass-card"
        style={{
          padding: "var(--s-5)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--s-3)",
          background: "var(--warn-soft)",
          border: "1px solid var(--warn)",
        }}
        role="alert"
      >
        <h1 style={{ margin: 0, fontSize: "var(--fs-l)", color: "var(--ink-0)" }}>
          Marketplace registry unreachable
        </h1>
        <p style={{ margin: 0, fontSize: "var(--fs-s)", color: "var(--ink-1)", lineHeight: 1.55 }}>
          Couldn&apos;t load the recipe index from{" "}
          <code style={{ fontSize: "var(--fs-xs)" }}>
            github.com/patchworkos/recipes
          </code>
          . The recipe{" "}
          <code style={{ fontSize: "var(--fs-xs)" }}>{fullName}</code> may or
          may not exist — we can&apos;t tell without the registry.
        </p>
        <p style={{ margin: 0, fontSize: "var(--fs-s)", color: "var(--ink-2)", lineHeight: 1.55 }}>
          Refresh the page in a minute, or use the CLI directly:
        </p>
        <code
          style={{
            background: "var(--recess)",
            padding: "10px 12px",
            borderRadius: "var(--r-2)",
            fontSize: "var(--fs-s)",
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
            overflowX: "auto",
            color: "var(--ink-1)",
          }}
        >
          patchwork recipe install {fullName}
        </code>
      </div>
    </section>
  );
}

function TrustNote() {
  return (
    <div
      style={{
        padding: "12px 16px",
        background: "var(--warn-soft)",
        border: "1px solid var(--warn)",
        borderRadius: "var(--r-3)",
        fontSize: "var(--fs-s)",
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
