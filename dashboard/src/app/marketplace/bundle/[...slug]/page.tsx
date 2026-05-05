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

export const revalidate = 300;

interface PageProps {
  params: { slug: string[] };
}

export async function generateMetadata({ params }: PageProps) {
  const fullName = decodeURIComponent(params.slug.join("/"));
  const registry = await fetchRegistry();
  const bundle = registry?.bundles?.find((b) => b.name === fullName);
  if (!bundle) return { title: "Not found — Marketplace · Patchwork OS" };
  return {
    title: `${shortName(bundle.name)} — Bundle · Marketplace · Patchwork OS`,
    description: bundle.description,
  };
}

export default async function BundleDetailPage({ params }: PageProps) {
  const fullName = decodeURIComponent(params.slug.join("/"));

  const registry = await fetchRegistry();
  const bundle = registry?.bundles?.find((b) => b.name === fullName);
  if (!bundle) notFound();

  const src = parseInstallSource(bundle.install);
  let manifest: BundleManifest | null = null;
  if (src) manifest = await fetchBundleManifest(src);

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "var(--s-6)" }}>
      <Link
        href="/marketplace"
        className="btn sm ghost"
        style={{ alignSelf: "flex-start", textDecoration: "none", fontSize: 12 }}
      >
        ← Back to marketplace
      </Link>

      <BundleHeader bundle={bundle} manifest={manifest} />

      <p style={{ fontSize: 14, color: "var(--ink-1)", lineHeight: 1.6, maxWidth: 760 }}>
        {manifest?.description ?? bundle.description}
      </p>

      <WhatIsIncluded bundle={bundle} manifest={manifest} />

      <ConnectorHealthPanel connectors={bundle.connectors} marginTop={0} />

      <TrustCard bundle={bundle} />

      {manifest?.required_env && manifest.required_env.length > 0 && (
        <RequiredEnvCard vars={manifest.required_env} />
      )}

      <InstallInstructions bundle={bundle} manifest={manifest} />

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
        <div style={{ fontSize: 11, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>
          Capability Bundle
        </div>
        <h1 style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)", letterSpacing: "-0.01em" }}>
          {shortName(bundle.name)}
        </h1>
        <div className="page-head-sub" style={{ fontSize: 13, color: "var(--ink-2)" }}>
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
      <h3 style={{ fontSize: 13, marginTop: 0, marginBottom: "var(--s-3)" }}>What&apos;s included</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
        {recipes.length > 0 && (
          <div>
            <div style={{ fontSize: 11, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "var(--s-1)" }}>
              Recipes ({recipes.length})
            </div>
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              {recipes.map((r) => (
                <li key={r} style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--fg-1)" }}>
                  <Link
                    href={`/marketplace/${encodeURIComponent(r)}`}
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
          <div style={{ fontSize: 12, color: "var(--fg-2)" }}>
            {bundle.recipe_count} recipe{bundle.recipe_count !== 1 ? "s" : ""} included
          </div>
        )}

        {plugin && (
          <div>
            <div style={{ fontSize: 11, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "var(--s-1)" }}>
              Plugin
            </div>
            <code style={{ fontSize: 12 }}>{plugin}</code>
            <p style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 4 }}>
              Installed via <code>npm install -g {plugin}</code> during bundle setup.
            </p>
          </div>
        )}

        {hasPolicy && (
          <div>
            <div style={{ fontSize: 11, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "var(--s-1)" }}>
              Policy template
            </div>
            <p style={{ fontSize: 12, color: "var(--fg-2)", margin: 0 }}>
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
      value: <span className={`pill ${RISK_PILL_CLASS[risk_level]}`} style={{ fontSize: 11 }}>{risk_level}</span>,
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
      <h3 style={{ fontSize: 13, marginTop: 0, marginBottom: "var(--s-3)" }}>Trust &amp; permissions</h3>
      <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
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
  );
}

function RequiredEnvCard({ vars }: { vars: string[] }) {
  return (
    <div className="glass-card" style={{ padding: "var(--s-5)" }}>
      <h3 style={{ fontSize: 13, marginTop: 0, marginBottom: "var(--s-3)" }}>Required environment variables</h3>
      <p style={{ fontSize: 12, color: "var(--fg-2)", marginTop: 0, marginBottom: "var(--s-3)" }}>
        Set these in your bridge environment before activating the bundle:
      </p>
      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        {vars.map((v) => (
          <li key={v} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <code style={{ fontSize: 12, background: "var(--bg-2)", padding: "2px 6px", borderRadius: "var(--r-1)" }}>{v}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

function InstallInstructions({
  bundle,
  manifest,
}: {
  bundle: RegistryBundle;
  manifest: BundleManifest | null;
}) {
  const plugin = manifest?.plugin;
  const recipes = manifest?.recipes ?? [];
  return (
    <div className="glass-card" style={{ padding: "var(--s-5)" }}>
      <h3 style={{ fontSize: 13, marginTop: 0, marginBottom: "var(--s-3)" }}>Install</h3>
      <p style={{ fontSize: 12, color: "var(--fg-2)", marginTop: 0 }}>
        Bundle install via a single command isn&apos;t wired through the
        bridge yet. Install each constituent recipe from the Marketplace —
        the trust + risk metadata above carries over per-recipe.
      </p>
      {recipes.length > 0 && (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: "var(--s-3) 0",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {recipes.map((r) => (
            <li
              key={r}
              style={{
                fontSize: 12,
                fontFamily: "var(--font-mono)",
                color: "var(--fg-1)",
              }}
            >
              <Link
                href={`/marketplace/${encodeURIComponent(r)}`}
                style={{
                  color: "inherit",
                  textDecoration: "underline",
                  textDecorationColor: "var(--line-2)",
                }}
              >
                {r}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {plugin && (
        <p style={{ fontSize: 12, color: "var(--fg-2)" }}>
          Plugin: <code style={{ fontSize: 11 }}>npm install -g {plugin}</code>, then restart the bridge with{" "}
          <code style={{ fontSize: 11 }}>--plugin {plugin}</code>.
        </p>
      )}
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
        fontSize: 12,
        color: "var(--ink-2)",
        lineHeight: 1.6,
      }}
    >
      <strong style={{ color: "var(--ink-1)" }}>Review before installing.</strong>{" "}
      Bundles can include recipes, plugins, and policy changes. Read the included components carefully. Policy templates are never applied without your explicit confirmation.
    </div>
  );
}
