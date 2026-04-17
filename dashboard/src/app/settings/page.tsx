"use client";
import { useEffect, useRef, useState } from "react";

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
    webhookUrl?: string | null;
  };
  [k: string]: unknown;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<StatusResponse | null>(null);
  const [err, setErr] = useState<string>();
  const [unsupported, setUnsupported] = useState(false);

  // Webhook URL field state
  const [webhookInput, setWebhookInput] = useState("");
  const [webhookSaving, setWebhookSaving] = useState(false);
  const [webhookSaveMsg, setWebhookSaveMsg] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const webhookInitialized = useRef(false);

  // Approval gate state
  const [gateValue, setGateValue] = useState<"off" | "high" | "all">("off");
  const [gateSaving, setGateSaving] = useState(false);
  const [gateSaveMsg, setGateSaveMsg] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const gateInitialized = useRef(false);

  useEffect(() => {
    const tick = async () => {
      try {
        const res = await fetch("/api/bridge/status");
        if (res.status === 404) {
          setUnsupported(true);
          return;
        }
        if (!res.ok) throw new Error(`/status ${res.status}`);
        const data = (await res.json()) as StatusResponse;
        setSettings(data);
        setErr(undefined);
        // Seed inputs only once so user edits aren't clobbered by polling
        if (!webhookInitialized.current) {
          setWebhookInput(data.patchwork?.webhookUrl ?? "");
          webhookInitialized.current = true;
        }
        if (!gateInitialized.current) {
          const g = data.patchwork?.approvalGate;
          if (g === "high" || g === "all") setGateValue(g);
          else setGateValue("off");
          gateInitialized.current = true;
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, []);

  async function saveGate(value: "off" | "high" | "all") {
    setGateSaving(true);
    setGateSaveMsg(null);
    try {
      const res = await fetch("/api/bridge/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalGate: value }),
      });
      if (res.ok) {
        setGateValue(value);
        setGateSaveMsg({ ok: true, text: "Saved." });
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setGateSaveMsg({
          ok: false,
          text: body.error ?? `Error ${res.status}`,
        });
      }
    } catch (e) {
      setGateSaveMsg({
        ok: false,
        text: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setGateSaving(false);
    }
  }

  async function saveWebhook() {
    setWebhookSaving(true);
    setWebhookSaveMsg(null);
    try {
      const res = await fetch("/api/bridge/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webhookUrl: webhookInput }),
      });
      if (res.ok) {
        setWebhookSaveMsg({ ok: true, text: "Saved." });
      } else {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setWebhookSaveMsg({
          ok: false,
          text: body.error ?? `Error ${res.status}`,
        });
      }
    } catch (e) {
      setWebhookSaveMsg({
        ok: false,
        text: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setWebhookSaving(false);
    }
  }

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
        <>
          <div className="card">
            <div className="card-head">
              <h2>Bridge</h2>
              <span className={`pill ${settings.extension ? "ok" : "warn"}`}>
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

          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-head">
              <h2>Integrations</h2>
            </div>

            {/* Approval gate control */}
            <div
              style={{
                padding: "16px 0 8px",
                borderBottom: "1px solid var(--border-subtle)",
              }}
            >
              <label
                htmlFor="approval-gate"
                style={{
                  display: "block",
                  fontSize: 13,
                  color: "var(--fg-1)",
                  marginBottom: 4,
                  fontWeight: 500,
                }}
              >
                Approval gate
              </label>
              <p
                style={{
                  fontSize: 12,
                  color: "var(--fg-2)",
                  margin: "0 0 10px",
                  lineHeight: 1.5,
                }}
              >
                Hold high-risk or all tool calls for dashboard review before
                execution. Takes effect for new sessions immediately.
              </p>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <select
                  id="approval-gate"
                  value={gateValue}
                  disabled={gateSaving}
                  onChange={(e) => {
                    setGateSaveMsg(null);
                    saveGate(e.target.value as "off" | "high" | "all");
                  }}
                  style={{
                    background: "var(--bg-2)",
                    border: "1px solid var(--border-default)",
                    borderRadius: "var(--r-2)",
                    color: "var(--fg-0)",
                    fontSize: 13,
                    padding: "6px 10px",
                    cursor: "pointer",
                    outline: "none",
                  }}
                >
                  <option value="off">off — no gating</option>
                  <option value="high">high — gate high-risk tools only</option>
                  <option value="all">all — gate every tool call</option>
                </select>
                {gateSaving && (
                  <span style={{ fontSize: 12, color: "var(--fg-3)" }}>
                    Saving…
                  </span>
                )}
              </div>
              {gateSaveMsg && (
                <p
                  style={{
                    fontSize: 12,
                    marginTop: 6,
                    color: gateSaveMsg.ok ? "var(--ok)" : "var(--err)",
                  }}
                >
                  {gateSaveMsg.text}
                </p>
              )}
            </div>

            <div
              style={{
                padding: "16px 0 8px",
                borderBottom: "1px solid var(--border-subtle)",
              }}
            >
              <label
                htmlFor="webhook-url"
                style={{
                  display: "block",
                  fontSize: 13,
                  color: "var(--fg-1)",
                  marginBottom: 4,
                  fontWeight: 500,
                }}
              >
                Approval webhook URL
              </label>
              <p
                style={{
                  fontSize: 12,
                  color: "var(--fg-2)",
                  margin: "0 0 10px",
                  lineHeight: 1.5,
                }}
              >
                Patchwork will POST a JSON payload to this URL when a new
                approval is queued. Use with Slack, ntfy.sh, Pushover, or any
                webhook receiver. Must be HTTPS.
              </p>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  id="webhook-url"
                  type="url"
                  value={webhookInput}
                  onChange={(e) => {
                    setWebhookInput(e.target.value);
                    setWebhookSaveMsg(null);
                  }}
                  placeholder="https://ntfy.sh/my-topic"
                  style={{
                    flex: 1,
                    background: "var(--bg-2)",
                    border: "1px solid var(--border-default)",
                    borderRadius: "var(--r-2)",
                    color: "var(--fg-0)",
                    fontSize: 13,
                    fontFamily: "var(--font-mono)",
                    padding: "6px 10px",
                    outline: "none",
                  }}
                />
                <button
                  type="button"
                  onClick={saveWebhook}
                  disabled={webhookSaving}
                  style={{
                    background: "var(--accent)",
                    color: "#fff",
                    border: "none",
                    borderRadius: "var(--r-2)",
                    padding: "6px 14px",
                    fontSize: 13,
                    cursor: webhookSaving ? "not-allowed" : "pointer",
                    opacity: webhookSaving ? 0.6 : 1,
                    whiteSpace: "nowrap",
                  }}
                >
                  {webhookSaving ? "Saving…" : "Save"}
                </button>
              </div>
              {webhookSaveMsg && (
                <p
                  style={{
                    fontSize: 12,
                    marginTop: 6,
                    color: webhookSaveMsg.ok ? "var(--ok)" : "var(--err)",
                  }}
                >
                  {webhookSaveMsg.text}
                </p>
              )}
            </div>
          </div>
        </>
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
