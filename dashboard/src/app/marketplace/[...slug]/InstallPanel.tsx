"use client";

import { useEffect, useState } from "react";
import { apiPath } from "@/lib/api";
import { assertValidInstallSource } from "@/lib/registry";

interface Props {
  install: string;
  name: string;
}

interface BridgeStatus {
  online: boolean;
  installed: boolean;
}

const POLL_TIMEOUT_MS = 1500;

export default function InstallPanel({ install, name }: Props) {
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), POLL_TIMEOUT_MS);

    fetch(apiPath("/api/bridge/recipes"), { signal: ac.signal })
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) {
          setStatus({ online: false, installed: false });
          return;
        }
        const data = await r.json();
        const list = Array.isArray(data) ? data : Array.isArray(data?.recipes) ? data.recipes : [];
        const installed = list.some((x: { name: string }) => x.name === name);
        setStatus({ online: true, installed });
      })
      .catch(() => {
        if (!cancelled) setStatus({ online: false, installed: false });
      })
      .finally(() => clearTimeout(timer));

    return () => {
      cancelled = true;
      ac.abort();
      clearTimeout(timer);
    };
  }, [name]);

  async function handleInstall() {
    setBusy(true);
    setErr(null);
    try {
      // Defense in depth: refuse to forward anything that isn't a
      // github:owner/repo[/path]@ref shape. Tampered registry indexes
      // could otherwise pass opaque strings (https://, file://, etc).
      assertValidInstallSource(install);
      const res = await fetch(apiPath("/api/bridge/recipes/install"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: install }),
      });
      if (!res.ok) {
        let msg = `Error ${res.status}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) msg = body.error;
        } catch {
          // ignore parse failure
        }
        throw new Error(msg);
      }
      setDone(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
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

  const installed = status?.installed === true || done;

  return (
    <div className="glass-card" style={{ padding: "var(--s-5)", display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 13, color: "var(--ink-1)" }}>
          {installed ? (
            <>
              <span style={{ color: "var(--ok)", marginRight: 6 }}>✓</span>
              Installed locally — enable with{" "}
              <code style={{ background: "var(--recess)", padding: "2px 6px", borderRadius: 4 }}>
                patchwork recipe enable {name.replace(/^@[^/]+\//, "")}
              </code>
            </>
          ) : status?.online ? (
            "Bridge connected — install with one click."
          ) : status === null ? (
            "Checking for local bridge…"
          ) : (
            "No local bridge detected. Install via CLI below."
          )}
        </div>

        {!installed && status?.online && (
          <button type="button" className="btn sm" onClick={handleInstall} disabled={busy}>
            {busy ? "Installing…" : "Install"}
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
            fontSize: 12,
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
        <div className="alert-err" role="alert" style={{ fontSize: 12 }}>
          {err}
        </div>
      )}
    </div>
  );
}
