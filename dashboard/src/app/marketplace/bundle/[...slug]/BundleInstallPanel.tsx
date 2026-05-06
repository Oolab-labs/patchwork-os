"use client";

import { useEffect, useState } from "react";
import { apiPath } from "@/lib/api";

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
}

interface BridgeStatus {
  online: boolean;
  /** Count of bundle recipes already installed (matched by name). */
  installedCount: number;
}

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
  error?: string;
  code?: string;
}

const POLL_TIMEOUT_MS = 1500;

export default function BundleInstallPanel({
  installSource,
  recipes,
  plugin,
  policyTemplate,
}: Props) {
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<BundleInstallResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const cliCmd = `patchwork recipe install ${installSource}`;

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), POLL_TIMEOUT_MS);

    fetch(apiPath("/api/bridge/recipes"), { signal: ac.signal })
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) {
          setStatus({ online: false, installedCount: 0 });
          return;
        }
        const data = await r.json();
        const list = Array.isArray(data)
          ? data
          : Array.isArray(data?.recipes)
            ? data.recipes
            : [];
        const installedNames = new Set(
          list.map((x: { name?: string }) => x.name).filter(Boolean),
        );
        const installedCount = recipes.filter((r) =>
          installedNames.has(r),
        ).length;
        setStatus({ online: true, installedCount });
      })
      .catch(() => {
        if (!cancelled) setStatus({ online: false, installedCount: 0 });
      })
      .finally(() => clearTimeout(timer));

    return () => {
      cancelled = true;
      ac.abort();
      clearTimeout(timer);
    };
  }, [recipes]);

  async function handleInstall() {
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
      // Bridge returns 200 on partial success (any installed) and 5xx on
      // full failure — both shapes carry `installed[]` + `failures[]`,
      // so render the result either way and surface a top-level error
      // banner only if there's no structured payload.
      setResult(body);
      if (!res.ok && (!body.installed || body.installed.length === 0)) {
        setErr(body.error ?? `Install failed (HTTP ${res.status})`);
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
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable
    }
  }

  const allInstalled =
    status?.installedCount === recipes.length && recipes.length > 0;
  const partialInstalled =
    status !== null &&
    status.installedCount > 0 &&
    status.installedCount < recipes.length;

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
              All {recipes.length} recipes installed locally — enable each
              with <code>patchwork recipe enable &lt;name&gt;</code>.
            </>
          ) : partialInstalled ? (
            <>
              {status.installedCount} of {recipes.length} recipes already
              installed. Install button will pull the missing{" "}
              {recipes.length - status.installedCount}.
            </>
          ) : status?.online ? (
            `Bridge connected — install all ${recipes.length} recipe${recipes.length === 1 ? "" : "s"} with one click.`
          ) : status === null ? (
            "Checking for local bridge…"
          ) : (
            "No local bridge detected. Install via CLI below."
          )}
        </div>

        {!allInstalled && status?.online && (
          <button
            type="button"
            className="btn sm"
            onClick={handleInstall}
            disabled={busy}
          >
            {busy ? "Installing…" : "Install bundle"}
          </button>
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
          {result.installed && result.installed.length > 0 && (
            <div style={{ fontSize: "var(--fs-s)", color: "var(--ink-1)" }}>
              <span style={{ color: "var(--ok)", marginRight: 6 }}>✓</span>
              Installed {result.installed.length} recipe
              {result.installed.length === 1 ? "" : "s"}:{" "}
              <span style={{ fontFamily: "var(--font-mono)" }}>
                {result.installed.map((r) => r.name).join(", ")}
              </span>
            </div>
          )}
          {result.failures && result.failures.length > 0 && (
            <div style={{ fontSize: "var(--fs-s)", color: "var(--err)" }}>
              <strong>{result.failures.length} failed:</strong>
              <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
                {result.failures.map((f) => (
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
        </div>
      )}

      {/* Plugin / policy template advisory — surface even before install
          so users know what additional manual steps are required.
          Mirrors the bridge response's `advisory.{plugin,policy_template}`
          fields when those are declared in the bundle manifest. */}
      {(plugin || policyTemplate) && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            fontSize: "var(--fs-s)",
            color: "var(--fg-2)",
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
    </div>
  );
}
