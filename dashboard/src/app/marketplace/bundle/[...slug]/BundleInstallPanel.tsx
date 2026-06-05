"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { apiPath } from "@/lib/api";
import { type RiskLevel, shortName } from "@/lib/registry";
import { InstallConfirmDialog } from "../../_components/InstallConfirmDialog";
import { MissingConnectorsNotice } from "../../_components/MissingConnectorsNotice";

interface Props {
  /**
   * Bundle install source as published in the registry — the full
   * `github:patchworkos/recipes/bundles/<name>` shape the bridge's
   * `/recipes/install` endpoint dispatches on. Same field the recipe
   * `InstallPanel` accepts under `install`.
   */
  installSource: string;
  /** Recipe names declared in `manifest.recipes[]`, used for the
   * "X of Y installed" count. */
  recipes: string[];
  /** Optional advisory surface for `manifest.plugin`. */
  plugin?: string;
  /** Optional advisory surface for `manifest.policy_template`. */
  policyTemplate?: string;
  // ── Confirm-dialog metadata (RegistryBundle.* via TrustMetadata) ──────
  /** Display name for the confirm dialog heading. */
  name: string;
  /** Optional risk metadata for the confirm dialog. Bundles always
   * trigger the confirm step (multi-recipe install + possible plugin),
   * but the metadata enriches what the user sees. */
  riskLevel?: RiskLevel;
  connectors?: string[];
  networkAccess?: boolean;
  fileAccess?: boolean;
}

// Three-state instead of boolean: distinguishes 401 (logged-out
// dashboard) from 503 (no bridge). Matches the fix PR #552 made on the
// browse view; PR #549 extended it to the single-recipe detail panel.
type BridgeStatus = "checking" | "online" | "offline" | "unauth";

interface BundleInstallResponse {
  ok: boolean;
  kind?: "bundle";
  bundleName?: string;
  installed?: Array<{ name: string; action: "created" | "replaced" }>;
  failures?: Array<{ name: string; error: string }>;
  advisory?: {
    plugin?: string;
    policy_template?: string;
  };
  /** Connectors the bundle's recipes need but the user hasn't
   * authorised yet — surfaced as an inline notice after install. */
  missingConnectors?: string[];
  error?: string;
  code?: string;
}

// 4000ms matches the single-recipe InstallPanel — a shorter window caused
// false "No local bridge detected" banners on cold start (slow first
// /api/bridge/recipes probe).
const POLL_TIMEOUT_MS = 4000;

export default function BundleInstallPanel({
  installSource,
  recipes,
  plugin,
  policyTemplate,
  name,
  riskLevel,
  connectors,
  networkAccess,
  fileAccess,
}: Props) {
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>("checking");
  const [installedCount, setInstalledCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<BundleInstallResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { clearTimeout(copyTimerRef.current); }, []);

  const cliCmd = `patchwork recipe install ${installSource}`;

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), POLL_TIMEOUT_MS);

    fetch(apiPath("/api/bridge/recipes"), { signal: ac.signal })
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) {
          setBridgeStatus(r.status === 401 ? "unauth" : "offline");
          return;
        }
        const data = await r.json();
        const list = Array.isArray(data)
          ? data
          : Array.isArray(data?.recipes)
            ? data.recipes
            : [];
        const installedNames = new Set<string>(
          list
            .map((x: { name?: string }) => x.name)
            .filter((n: string | undefined): n is string => Boolean(n)),
        );
        // Bundle manifest entries may be scoped (`@scope/name`); the
        // bridge writes recipes under their unscoped YAML `name:`. Strip
        // the scope before comparing.
        const count = recipes.filter((r) =>
          installedNames.has(shortName(r)),
        ).length;
        setBridgeStatus("online");
        setInstalledCount(count);
      })
      .catch(() => {
        if (!cancelled) setBridgeStatus("offline");
      })
      .finally(() => clearTimeout(timer));

    return () => {
      cancelled = true;
      ac.abort();
      clearTimeout(timer);
    };
  }, [recipes]);

  async function runInstall() {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const res = await fetch(apiPath("/api/bridge/recipes/install"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: installSource }),
      });
      const body = (await res.json()) as BundleInstallResponse;
      setResult(body);
      // Render the headline by partial-completion AND by HTTP status:
      //   - !res.ok with no installed items → full failure (red banner).
      //   - !res.ok with SOME installed items → partial (also surface
      //     the bridge error message — pre-fix this branch silently fell
      //     through to the green "Installed N" headline despite the 5xx).
      //   - res.ok → success path; bump the counter.
      const hasInstalled = !!body.installed && body.installed.length > 0;
      if (!res.ok) {
        if (res.status === 401) setBridgeStatus("unauth");
        else if (res.status >= 500) setBridgeStatus("offline");
        setErr(body.error ?? `Install failed (HTTP ${res.status})`);
        // Still bump the count when partial — those recipes ARE
        // installed even if the bundle as a whole errored.
        if (hasInstalled) {
          setInstalledCount((prev) => prev + body.installed!.length);
        }
      } else if (hasInstalled) {
        setInstalledCount((prev) => prev + body.installed!.length);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(cliCmd);
      setCopied(true);
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable
    }
  }

  const allInstalled = installedCount === recipes.length && recipes.length > 0;
  const partialInstalled = installedCount > 0 && installedCount < recipes.length;

  // Build the extra bullets for the confirm dialog. Bundles inherently
  // span N recipes, so always surface that count; plugin / policy-template
  // get their own line so users see them BEFORE confirming, not as a
  // post-install advisory surprise.
  const extraBullets: string[] = [];
  extraBullets.push(
    `Installs ${recipes.length} recipe${recipes.length === 1 ? "" : "s"}`,
  );
  if (plugin) {
    extraBullets.push(
      `Recommends installing companion plugin "${plugin}" via npm`,
    );
  }
  if (policyTemplate) {
    extraBullets.push(`Includes a policy template (${policyTemplate})`);
  }

  return (
    <div
      className="glass-card"
      style={{
        padding: "var(--s-5)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <h3 style={{ fontSize: "var(--fs-m)", marginTop: 0, marginBottom: 0 }}>
        Install
      </h3>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontSize: "var(--fs-m)", color: "var(--ink-1)" }}>
          {allInstalled ? (
            <>
              <span style={{ color: "var(--ok)", marginRight: 6 }}>✓</span>
              All {recipes.length} recipes installed locally — they run on
              their triggers immediately. To pause one, use{" "}
              <code>patchwork recipe disable &lt;name&gt;</code>.
            </>
          ) : partialInstalled ? (
            <>
              {installedCount} of {recipes.length} recipes already installed.
              Install button will pull the missing{" "}
              {recipes.length - installedCount}.
            </>
          ) : bridgeStatus === "online" ? (
            `Bridge connected — install all ${recipes.length} recipe${recipes.length === 1 ? "" : "s"} with one click.`
          ) : bridgeStatus === "checking" ? (
            "Checking for local bridge…"
          ) : bridgeStatus === "unauth" ? (
            "Bridge reachable but the dashboard is logged out. Sign in to install in one click, or use the CLI below."
          ) : (
            "No local bridge detected. Install via CLI below."
          )}
        </div>

        {!allInstalled && bridgeStatus === "online" && (
          <button
            type="button"
            className="btn sm"
            // Bundles always go through the confirm step — pulling N
            // recipes and possibly a plugin is too high-impact for
            // one-tap install regardless of declared risk level.
            onClick={() => setConfirmOpen(true)}
            disabled={busy}
          >
            {busy ? "Installing…" : "Install bundle"}
          </button>
        )}
        {!allInstalled && bridgeStatus === "unauth" && (
          <Link
            href={`/login?next=/dashboard/marketplace/bundle/${name}`}
            className="btn sm"
            style={{ textDecoration: "none", flexShrink: 0 }}
          >
            Log in
          </Link>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <code
          style={{
            flex: 1,
            background: "var(--recess)",
            padding: "10px 12px",
            borderRadius: "var(--r-2)",
            fontSize: "var(--fs-s)",
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
            overflowX: "auto",
            color: "var(--ink-1)",
          }}
        >
          {cliCmd}
        </code>
        <button
          type="button"
          className="btn sm ghost"
          onClick={handleCopy}
          aria-label="Copy install command"
          style={{ flexShrink: 0 }}
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>

      {result && (result.installed || result.failures) && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            paddingTop: 4,
            borderTop: "1px solid var(--line-1)",
          }}
        >
          {(() => {
            // Wave 1 fix: when failures dominate (more recipes failed
            // than installed), demote the green "✓ Installed N recipes"
            // headline to yellow "Installed with errors" so the user
            // doesn't miss the red failure list sitting underneath.
            // Previously a 1-of-5-installed result still showed a
            // green checkmark + downplayed failures.
            //
            // Wave 2 fix (item 14): same demotion applies when the
            // bundle declared a plugin or policy_template — the green
            // success line hid the "Manual follow-up needed" block
            // below, and users reported "the bundle installed but my
            // plugin tool doesn't work." Yellow + "Installed with
            // follow-up required" headline keeps the block visible.
            const installedCount = result.installed?.length ?? 0;
            const failureCount = result.failures?.length ?? 0;
            const failuresDominate = failureCount > installedCount;
            const hasAdvisory = Boolean(plugin || policyTemplate);
            const elevated = failuresDominate || hasAdvisory;
            const headlineText = failuresDominate
              ? `Only ${installedCount} of ${installedCount + failureCount} recipes installed`
              : hasAdvisory
                ? `Installed ${installedCount} recipe${installedCount === 1 ? "" : "s"} — follow-up required`
                : `Installed ${installedCount} recipe${installedCount === 1 ? "" : "s"}`;
            return (
              <>
                {installedCount > 0 && (
                  <div
                    style={{ fontSize: "var(--fs-s)", color: "var(--ink-1)" }}
                  >
                    <span
                      style={{
                        color: elevated ? "var(--warn)" : "var(--ok)",
                        marginRight: 6,
                      }}
                    >
                      {elevated ? "⚠" : "✓"}
                    </span>
                    {headlineText}
                    :{" "}
                    <span style={{ fontFamily: "var(--font-mono)" }}>
                      {result.installed?.map((r) => r.name).join(", ")}
                    </span>
                  </div>
                )}
                {failureCount > 0 && (
                  <div style={{ fontSize: "var(--fs-s)", color: "var(--err)" }}>
                    <strong>{failureCount} failed:</strong>
                    <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
                      {result.failures?.map((f) => (
                        <li key={f.name}>
                          <span style={{ fontFamily: "var(--font-mono)" }}>
                            {f.name}
                          </span>
                          {" — "}
                          {f.error}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}

      {result?.missingConnectors && result.missingConnectors.length > 0 && (
        <MissingConnectorsNotice connectors={result.missingConnectors} />
      )}

      {(plugin || policyTemplate) && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            fontSize: "var(--fs-s)",
            color: "var(--ink-2)",
            paddingTop: 4,
            borderTop: "1px solid var(--line-1)",
          }}
        >
          <div style={{ fontWeight: 500, color: "var(--ink-1)" }}>
            Manual follow-up needed:
          </div>
          {plugin && (
            <div>
              Plugin{" "}
              <code style={{ fontSize: "var(--fs-xs)" }}>{plugin}</code> is
              not auto-installed. Run{" "}
              <code style={{ fontSize: "var(--fs-xs)" }}>
                npm install -g {plugin}
              </code>{" "}
              and restart the bridge with{" "}
              <code style={{ fontSize: "var(--fs-xs)" }}>--plugin {plugin}</code>
              .
            </div>
          )}
          {policyTemplate && (
            <div>
              Policy template{" "}
              <code style={{ fontSize: "var(--fs-xs)" }}>{policyTemplate}</code>{" "}
              is not auto-applied. Review and apply manually.
            </div>
          )}
        </div>
      )}

      {err && (
        <div
          className="alert-err"
          role="alert"
          style={{ fontSize: "var(--fs-s)" }}
        >
          {err}
        </div>
      )}

      <InstallConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => void runInstall()}
        name={`${shortName(name)} bundle`}
        source={installSource}
        riskLevel={riskLevel}
        connectors={connectors}
        networkAccess={networkAccess}
        fileAccess={fileAccess}
        extraBullets={extraBullets}
        confirmLabel="Install bundle"
      />
    </div>
  );
}
