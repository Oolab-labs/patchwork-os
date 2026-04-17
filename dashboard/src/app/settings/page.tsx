"use client";
import { useEffect, useState } from "react";

interface StatusResponse {
  uptimeMs?: number;
  claudeCode?: boolean;
  activeSessions?: number;
  extension?: boolean;
  patchwork?: {
    port?: number;
    workspace?: string;
    approvalGate?: string;
    fullMode?: boolean;
    claudeDriver?: string;
    automationEnabled?: boolean;
  };
  [k: string]: unknown;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<StatusResponse | null>(null);
  const [err, setErr] = useState<string>();
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    const tick = async () => {
      try {
        const res = await fetch("/api/bridge/status");
        if (res.status === 404) {
          setUnsupported(true);
          return;
        }
        if (!res.ok) throw new Error(`/status ${res.status}`);
        setSettings((await res.json()) as StatusResponse);
        setErr(undefined);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
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
              className={`pill ${settings.extension ? "ok" : "warn"}`}
            >
              extension {settings.extension ? "connected" : "offline"}
            </span>
          </div>
          <Row
            label="Port"
            value={settings.patchwork?.port?.toString() ?? "—"}
            mono
          />
          <Row
            label="Workspace"
            value={settings.patchwork?.workspace ?? "—"}
            mono
          />
          <Row
            label="Approval gate"
            value={settings.patchwork?.approvalGate ?? "off"}
          />
          <Row
            label="Mode"
            value={settings.patchwork?.fullMode === false ? "slim" : "full"}
          />
          <Row
            label="Claude driver"
            value={settings.patchwork?.claudeDriver ?? "none"}
          />
          <Row
            label="Automation"
            value={settings.patchwork?.automationEnabled ? "enabled" : "off"}
          />
          <Row
            label="Active Claude sessions"
            value={(settings.activeSessions ?? 0).toString()}
            mono
          />
          <Row
            label="Uptime"
            value={
              settings.uptimeMs != null
                ? `${Math.floor(settings.uptimeMs / 1000)}s`
                : "—"
            }
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
