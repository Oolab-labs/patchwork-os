import Link from "next/link";
import { notFound } from "next/navigation";
import { ConnectorHealthPanel } from "@/components/ConnectorHealthPanel";
import {
  fetchBundleManifest,
  fetchRegistry,
  parseInstallSource,
  type ApprovalBehavior,
  type BundleManifest,
  type RegistryBundle,
  type RiskLevel,
  shortName,
} from "@/lib/registry";
import BundleInstallPanel from "./BundleInstallPanel";

// 60s (was 300s) — match the recipe detail page; freshly merged
// bundles shouldn't 404 for 5 min after the registry PR lands.
export const revalidate = 60;

// Same fix as the recipe detail page (marketplace/[...slug]/page.tsx):
// fetchGithubFile's own `next: { revalidate }` fetch-cache option
// defaults to 300s independently of the route segment's revalidate
// above — pass it explicitly so a bundle manifest edit is visible within
// the same 60s window the page itself re-renders on, not up to 5x later.
const FETCH_OPTS = { revalidate };

interface PageProps {
  // Next 15: dynamic route params are Promise-typed.
  params: Promise<{ slug: string[] }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params;
  const fullName = decodeURIComponent(slug.join("/"));
  const registry = await fetchRegistry(FETCH_OPTS);
  if (!registry) {
    return { title: "Registry unreachable — Marketplace · Patchwork OS" };
  }
  const bundle = registry.bundles?.find((b) => b.name === fullName);
  if (!bundle) return { title: "Not found — Marketplace · Patchwork OS" };
  return {
    title: `${shortName(bundle.name)} — Bundle · Marketplace · Patchwork OS`,
    description: bundle.description,
  };
}

export default async function BundleDetailPage({ params }: PageProps) {
  const { slug } = await params;
  const fullName = decodeURIComponent(slug.join("/"));

  const registry = await fetchRegistry(FETCH_OPTS);
  // Same fix as the recipe detail page: don't conflate "registry
  // unreachable" with "bundle missing". Pre-fix, every bundle URL 404'd
  // whenever the CDN was down.
  if (!registry) return <RegistryUnreachable fullName={fullName} />;
  const bundle = registry.bundles?.find((b) => b.name === fullName);
  if (!bundle) notFound();

  const src = parseInstallSource(bundle.install);
  let manifest: BundleManifest | null = null;
  let manifestErr = false;
  if (src) {
    try {
      manifest = await fetchBundleManifest(src, FETCH_OPTS);
      // fetchBundleManifest swallows network errors and returns null —
      // treat null as a manifest-unavailable signal so the page renders
      // a notice instead of an empty bundle.
      manifestErr = manifest === null;
    } catch {
      manifest = null;
      manifestErr = true;
    }
  } else {
    manifestErr = true;
  }

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "var(--s-6)" }}>
      <Link
        href="/marketplace"
        className="btn sm ghost"
        style={{ alignSelf: "flex-start", textDecoration: "none", fontSize: "var(--fs-s)" }}
      >
        ← Back to marketplace
      </Link>

      <BundleHeader bundle={bundle} manifest={manifest} />

      <p style={{ fontSize: "var(--fs-base)", color: "var(--ink-1)", lineHeight: 1.6, maxWidth: 760 }}>
        {manifest?.description ?? bundle.description}
      </p>

      {manifestErr && <ManifestUnavailableNotice bundle={bundle} />}

      <WhatIsIncluded bundle={bundle} manifest={manifest} />

      <ConnectorHealthPanel connectors={bundle.connectors} marginTop={0} />

      <TrustCard bundle={bundle} />

      {manifest?.required_env && manifest.required_env.length > 0 && (
        <RequiredEnvCard vars={manifest.required_env} />
      )}

      <BundleInstallPanel
        installSource={bundle.install}
        recipes={manifest?.recipes ?? []}
        name={bundle.name}
        riskLevel={bundle.risk_level ?? manifest?.risk_level}
        connectors={bundle.connectors}
        networkAccess={bundle.network_access ?? manifest?.network_access}
        fileAccess={bundle.file_access ?? manifest?.file_access}
        {...(manifest?.plugin && { plugin: manifest.plugin })}
        {...(manifest?.policy_template && {
          policyTemplate: manifest.policy_template,
        })}
      />

      <TrustNote />
    </section>
  );
}

// ----------------------------------------------------------------- subcomponents

const RISK_PILL_CLASS: Record<RiskLevel, string> = { low: "ok", medium: "warn", high: "err" };
const APPROVAL_LABEL: Record<ApprovalBehavior, string> = {
  always_ask: "Always asks for approval",
  ask_on_novel: "Asks on new tools / specifiers",
  auto_approve: "Designed to run unattended once trusted",
};

function BundleHeader({
  bundle,
  manifest,
}: {
  bundle: RegistryBundle;
  manifest: BundleManifest | null;
}) {
  const author = manifest?.author ?? bundle.maintainer;
  return (
    <div className="page-head">
      <div>
        <div style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)", marginBottom: 4 }}>
          Capability bundle
        </div>
        <h1 style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)", letterSpacing: "-0.01em" }}>
          {shortName(bundle.name)}
        </h1>
        <div className="page-head-sub" style={{ fontSize: "var(--fs-m)", color: "var(--ink-2)" }}>
          {bundle.name}
          <span style={{ margin: "0 8px", color: "var(--ink-3)" }}>·</span>
          <span>v{bundle.version}</span>
          {author && (
            <>
              <span style={{ margin: "0 8px", color: "var(--ink-3)" }}>·</span>
              <span>by {author}</span>
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
        {bundle.tags.map((t) => (
          <span key={t} className="tag-pill">{t}</span>
        ))}
      </div>
    </div>
  );
}

function WhatIsIncluded({
  bundle,
  manifest,
}: {
  bundle: RegistryBundle;
  manifest: BundleManifest | null;
}) {
  const recipes = manifest?.recipes ?? [];
  const plugin = manifest?.plugin ?? (bundle.has_plugin ? "companion plugin" : null);
  const hasPolicy = manifest?.policy_template ?? bundle.has_policy;

  return (
    <div className="glass-card" style={{ padding: "var(--s-5)" }}>
      <h3 style={{ fontSize: "var(--fs-m)", marginTop: 0, marginBottom: "var(--s-3)" }}>What&apos;s included</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
        {recipes.length > 0 && (
          <div>
            <div style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)", marginBottom: "var(--s-1)" }}>
              Recipes ({recipes.length})
            </div>
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              {recipes.map((r) => (
                <li key={r} style={{ fontSize: "var(--fs-s)", fontFamily: "var(--font-mono)", color: "var(--ink-1)" }}>
                  <Link
                    href={`/marketplace/${r.split("/").map(encodeURIComponent).join("/")}`}
                    style={{ color: "inherit", textDecoration: "underline", textDecorationColor: "var(--line-2)" }}
                  >
                    {r}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        {recipes.length === 0 && bundle.recipe_count != null && bundle.recipe_count > 0 && (
          <div style={{ fontSize: "var(--fs-s)", color: "var(--ink-2)" }}>
            {bundle.recipe_count} recipe{bundle.recipe_count !== 1 ? "s" : ""} included
          </div>
        )}

        {plugin && (
          <div>
            <div style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)", marginBottom: "var(--s-1)" }}>
              Plugin
            </div>
            <code style={{ fontSize: "var(--fs-s)" }}>{plugin}</code>
            <p style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)", marginTop: 4 }}>
              Installed via <code>npm install -g {plugin}</code> during bundle setup.
            </p>
          </div>
        )}

        {hasPolicy && (
          <div>
            <div style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)", marginBottom: "var(--s-1)" }}>
              Policy template
            </div>
            <p style={{ fontSize: "var(--fs-s)", color: "var(--ink-2)", margin: 0 }}>
              A delegation policy fragment is included. It will be shown for your review and requires explicit approval before being applied — never applied silently.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function TrustCard({ bundle }: { bundle: RegistryBundle }) {
  const { risk_level, network_access, file_access, approval_behavior } = bundle;
  const hasAny = risk_level || network_access != null || file_access != null || approval_behavior;
  if (!hasAny) return null;

  const rows: Array<{ label: string; value: React.ReactNode }> = [];
  if (risk_level) {
    rows.push({
      label: "Risk level",
      value: <span className={`pill ${RISK_PILL_CLASS[risk_level]}`} style={{ fontSize: "var(--fs-xs)" }}>{risk_level}</span>,
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

function RequiredEnvCard({ vars }: { vars: string[] }) {
  return (
    <div className="glass-card" style={{ padding: "var(--s-5)" }}>
      <h3 style={{ fontSize: "var(--fs-m)", marginTop: 0, marginBottom: "var(--s-3)" }}>Required environment variables</h3>
      <p style={{ fontSize: "var(--fs-s)", color: "var(--ink-2)", marginTop: 0, marginBottom: "var(--s-3)" }}>
        Set these in your bridge environment before activating the bundle:
      </p>
      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        {vars.map((v) => (
          <li key={v} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <code style={{ fontSize: "var(--fs-s)", background: "var(--bg-2)", padding: "2px 6px", borderRadius: "var(--r-1)" }}>{v}</code>
          </li>
        ))}
      </ul>
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
          Couldn&apos;t load the bundle index from{" "}
          <code style={{ fontSize: "var(--fs-xs)" }}>
            github.com/patchworkos/recipes
          </code>
          . The bundle{" "}
          <code style={{ fontSize: "var(--fs-xs)" }}>{fullName}</code> may or
          may not exist — we can&apos;t tell without the registry.
        </p>
        <p style={{ margin: 0, fontSize: "var(--fs-s)", color: "var(--ink-2)", lineHeight: 1.55 }}>
          Refresh in a minute, or install via CLI:
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

function ManifestUnavailableNotice({ bundle }: { bundle: RegistryBundle }) {
  return (
    <div
      className="glass-card"
      style={{
        padding: "var(--s-4) var(--s-5)",
        background: "var(--warn-soft)",
        border: "1px solid var(--warn)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--s-2)",
      }}
      role="status"
    >
      <strong style={{ fontSize: "var(--fs-s)", color: "var(--ink-0)" }}>
        Bundle manifest unavailable
      </strong>
      <p style={{ margin: 0, fontSize: "var(--fs-s)", color: "var(--ink-1)", lineHeight: 1.55 }}>
        We couldn&apos;t load{" "}
        <code style={{ fontSize: "var(--fs-xs)" }}>{bundle.install}</code>/manifest.json
        — the page below shows only what the registry knows. Specific recipe
        list, plugin name, policy template, and required env may be missing.
        Reload to retry, or install via CLI which fetches the manifest
        directly:{" "}
        <code style={{ fontSize: "var(--fs-xs)" }}>
          patchwork recipe install {bundle.name}
        </code>
        .
      </p>
    </div>
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
      <strong style={{ color: "var(--ink-1)" }}>Review before installing.</strong>{" "}
      Bundles can include recipes, plugins, and policy changes. Read the included components carefully. Policy templates are never applied without your explicit confirmation.
    </div>
  );
}
