"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiPath } from "@/lib/api";
import {
  assertValidInstallSource,
  formatConnectorLabel,
  type RiskLevel,
  shortName,
} from "@/lib/registry";
import { InstallConfirmDialog } from "../_components/InstallConfirmDialog";
import { MissingConnectorsNotice } from "../_components/MissingConnectorsNotice";

interface Props {
  install: string;
  name: string;
  /**
   * Optional risk metadata. When `riskLevel` is medium/high OR
   * `networkAccess`/`fileAccess` is true, clicking Install opens the
   * confirm dialog instead of installing one-tap — same gating as the
   * browse-view RecipeCard. Pre-fix, the detail page skipped the
   * confirm step entirely so installing a high-risk recipe from a
   * share link was one click.
   */
  riskLevel?: RiskLevel;
  connectors?: string[];
  networkAccess?: boolean;
  fileAccess?: boolean;
}

// Three-state instead of boolean — distinguishes 401 (logged-out
// dashboard, bridge IS reachable) from 503 (bridge truly down). PR #552
// fixed this on the browse view; this panel was missed in that wave.
type BridgeStatus = "checking" | "online" | "offline" | "unauth";

// Browse view uses 4s for the registry probe; the install panel was
// using 1.5s which produced false-negative "No local bridge detected"
// banners on slow loopback / cold-start. Align with browse.
const POLL_TIMEOUT_MS = 4000;

export default function InstallPanel({
  install,
  name,
  riskLevel,
  connectors,
  networkAccess,
  fileAccess,
}: Props) {
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>("checking");
  const [installed, setInstalled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Bridge ships `missingConnectors[]` on the install response when the
  // recipe uses connectors that haven't been authorised yet (see
  // connectorPreflight). Surfacing this on the detail panel matters more
  // than on the browse view's transient toast — the detail page is
  // where users land from a share link and where they'll come back to
  // troubleshoot if the recipe never runs.
  const [missingConnectors, setMissingConnectors] = useState<string[]>([]);

  // Marketplace trust Wave 0 (#782 follow-up): default-deny semantics.
  //
  // Previously the confirmation dialog ONLY appeared when one of
  // {riskLevel >= medium, networkAccess === true, fileAccess === true}
  // was set, which meant a registry author who forgot to flag a
  // file-writing recipe gave users a silent one-tap install. The live
  // marketplace registry has NO trust metadata on any recipe today
  // (`risk_level`/`network_access`/`file_access` are absent), so every
  // live install bypassed confirmation.
  //
  // New rule: only bypass confirmation if the recipe EXPLICITLY claims
  // low risk AND explicitly disclaims network + file access. Anything
  // missing those flags is treated as elevated — same as if the author
  // explicitly marked it high-risk. Honest fail-closed.
  const elevated = !(
    riskLevel === "low" &&
    networkAccess === false &&
    fileAccess === false
  );

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
        // Bridge stores recipes under the unscoped YAML `name:`; the
        // detail page receives the scoped registry name.
        const target = shortName(name);
        const isInstalled = list.some(
          (x: { name: string }) => x.name === target,
        );
        setBridgeStatus("online");
        setInstalled(isInstalled);
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
  }, [name]);

  async function runInstall() {
    setBusy(true);
    setErr(null);
    setMissingConnectors([]);
    try {
      assertValidInstallSource(install);
      const res = await fetch(apiPath("/api/bridge/recipes/install"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: install }),
      });
      let parsed: { error?: string; missingConnectors?: unknown } = {};
      try {
        parsed = (await res.json()) as typeof parsed;
      } catch {
        // ignore parse failure — fall back to status-only error below
      }
      if (!res.ok) {
        // Reflect transport-level failure into the status so the user
        // sees Log-in / Get-Patchwork on the next click instead of a
        // stuck Install button.
        if (res.status === 401) setBridgeStatus("unauth");
        else if (res.status >= 500) setBridgeStatus("offline");
        throw new Error(parsed.error ?? `Error ${res.status}`);
      }
      // Capture missingConnectors[] before flipping `done` so the inline
      // notice has the list to render on the same paint.
      if (Array.isArray(parsed.missingConnectors)) {
        setMissingConnectors(
          parsed.missingConnectors.filter(
            (c): c is string => typeof c === "string",
          ),
        );
      }
      setDone(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function handleInstall() {
    if (elevated) {
      setConfirmOpen(true);
      return;
    }
    void runInstall();
  }

  const cliCmd = `patchwork recipe install ${install}`;
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(cliCmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable
    }
  }

  const isInstalled = installed || done;

  return (
    <div className="glass-card" style={{ padding: "var(--s-5)", display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: "var(--fs-m)", color: "var(--ink-1)" }}>
          {isInstalled ? (
            <>
              <span style={{ color: "var(--ok)", marginRight: 6 }}>✓</span>
              Installed locally — runs on its trigger immediately. To
              pause it later, use{" "}
              <code style={{ background: "var(--recess)", padding: "2px 6px", borderRadius: 4 }}>
                patchwork recipe disable {shortName(name)}
              </code>
              .
            </>
          ) : bridgeStatus === "online" ? (
            "Bridge connected — install with one click."
          ) : bridgeStatus === "checking" ? (
            "Checking for local bridge…"
          ) : bridgeStatus === "unauth" ? (
            "Bridge reachable but the dashboard is logged out. Sign in to install in one click, or use the CLI below."
          ) : (
            "No local bridge detected. Install via CLI below."
          )}
        </div>

        {!isInstalled && bridgeStatus === "online" && (
          <button type="button" className="btn sm" onClick={handleInstall} disabled={busy}>
            {busy ? "Installing…" : "Install"}
          </button>
        )}
        {!isInstalled && bridgeStatus === "unauth" && (
          <Link
            href={`/login?next=${encodeURIComponent(`/dashboard/marketplace/${name}`)}`}
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

      {err && (
        <div className="alert-err" role="alert" style={{ fontSize: "var(--fs-s)" }}>
          {err}
        </div>
      )}

      {missingConnectors.length > 0 && (
        <MissingConnectorsNotice connectors={missingConnectors} />
      )}

      <InstallConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => void runInstall()}
        name={shortName(name)}
        source={install}
        riskLevel={riskLevel}
        connectors={connectors}
        networkAccess={networkAccess}
        fileAccess={fileAccess}
      />
    </div>
  );
}
