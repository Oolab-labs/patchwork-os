"use client";
import { useEffect, useState } from "react";

interface Settings {
  port?: number;
  workspace?: string;
  extensionConnected?: boolean;
  slim?: boolean;
  approvalGate?: string;
  protocolVersion?: string;
  packageVersion?: string;
  [k: string]: unknown;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [err, setErr] = useState<string>();
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/bridge/status");
        if (res.status === 404) {
          setUnsupported(true);
          return;
        }
        if (!res.ok) throw new Error(`/status ${res.status}`);
        setSettings((await res.json()) as Settings);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <div className="page-head-sub">
            Current bridge configuration. Edit via CLI flags or{" "}
            <code>config.json</code>.
          </div>
        </div>
      </div>

      {err && <div className="alert-err">Unreachable: {err}</div>}

      {unsupported ? (
        <div className="empty-state">
          <h3>Settings endpoint coming in next phase</h3>
          <p>
            This bridge version does not expose <code>/status</code>. Run{" "}
            <code>patchwork print-token</code> for connection details.
          </p>
        </div>
      ) : !settings ? (
        <div className="empty-state">
          <p>Loading…</p>
        </div>
      ) : (
        <div className="card">
          <div className="card-head">
            <h2>Bridge</h2>
            <span
              className={`pill ${settings.extensionConnected ? "ok" : "warn"}`}
            >
              extension {settings.extensionConnected ? "connected" : "offline"}
            </span>
          </div>
          <Row label="Port" value={settings.port?.toString() ?? "—"} mono />
          <Row label="Workspace" value={settings.workspace ?? "—"} mono />
          <Row
            label="Approval gate"
            value={settings.approvalGate ?? "default"}
          />
          <Row label="Mode" value={settings.slim ? "slim" : "full"} />
          <Row
            label="Protocol version"
            value={settings.protocolVersion ?? "—"}
            mono
          />
          <Row
            label="Package version"
            value={settings.packageVersion ?? "—"}
            mono
          />
        </div>
      )}
    </section>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 16,
        padding: "10px 0",
        borderBottom: "1px solid var(--border-subtle)",
        fontSize: 13,
      }}
    >
      <span style={{ color: "var(--fg-2)" }}>{label}</span>
      <span
        className={mono ? "mono" : undefined}
        style={{ color: "var(--fg-0)" }}
      >
        {value}
      </span>
    </div>
  );
}
