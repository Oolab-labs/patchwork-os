"use client";
import { useEffect, useRef, useState } from "react";
import { apiPath } from "@/lib/api";

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
    driver?: string;
    automationEnabled?: boolean;
    webhookUrl?: string | null;
  };
  [k: string]: unknown;
}

const DRIVER_OPTIONS = [
  { value: "none", label: "None (disabled)" },
  { value: "subprocess", label: "Claude Code (subprocess)" },
  { value: "api", label: "Claude API" },
  { value: "openai", label: "OpenAI" },
  { value: "grok", label: "Grok (xAI)" },
  { value: "gemini", label: "Gemini CLI" },
] as const;

const DRIVER_KEY_PROVIDER: Record<
  string,
  { provider: string; label: string; placeholder: string } | null
> = {
  none: null,
  subprocess: null,
  api: { provider: "anthropic", label: "Anthropic API key", placeholder: "sk-ant-…" },
  openai: { provider: "openai", label: "OpenAI API key", placeholder: "sk-…" },
  grok: { provider: "xai", label: "xAI API key", placeholder: "xai-…" },
  gemini: { provider: "google", label: "Google API key (or leave blank for gcloud ADC)", placeholder: "AIza…" },
};

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

  // AI driver state
  const [driverValue, setDriverValue] = useState("none");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [driverSaving, setDriverSaving] = useState(false);
  const [driverSaveMsg, setDriverSaveMsg] = useState<{
    ok: boolean;
    text: string;
    restart?: boolean;
  } | null>(null);
  const driverInitialized = useRef(false);

  useEffect(() => {
    const tick = async () => {
      try {
        const res = await fetch(apiPath("/api/bridge/status"));
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
        if (!driverInitialized.current) {
          const d = data.patchwork?.driver ?? "none";
          setDriverValue(d);
          driverInitialized.current = true;
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
      const res = await fetch(apiPath("/api/bridge/settings"), {
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
      const res = await fetch(apiPath("/api/bridge/settings"), {
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

  async function saveDriver() {
    setDriverSaving(true);
    setDriverSaveMsg(null);
    try {
      const keyMeta = DRIVER_KEY_PROVIDER[driverValue];
      const payload: Record<string, unknown> = { driver: driverValue };
      if (keyMeta && apiKeyInput.trim()) {
        payload.apiKey = { provider: keyMeta.provider, key: apiKeyInput.trim() };
      }
      const res = await fetch(apiPath("/api/bridge/settings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        restartRequired?: boolean;
      };
      if (res.ok && body.ok) {
        setDriverSaveMsg({
          ok: true,
          text: "Saved.",
          restart: body.restartRequired,
        });
        setApiKeyInput("");
      } else {
        setDriverSaveMsg({
          ok: false,
          text: body.error ?? `Error ${res.status}`,
        });
      }
    } catch (e) {
      setDriverSaveMsg({
        ok: false,
        text: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setDriverSaving(false);
    }
  }

  const activeDriver = settings?.patchwork?.driver ?? "none";
  const selectedKeyMeta = DRIVER_KEY_PROVIDER[driverValue] ?? null;

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <div className="page-head-sub">
            Configure the bridge. Most changes need a restart.
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
              label="AI driver"
              value={activeDriver}
              pill={activeDriver !== "none" ? "ok" : undefined}
            />
            <Row
              label="Automation"
              value={settings.patchwork?.automationEnabled ? "enabled" : "off"}
            />
            <Row
              label="Active sessions"
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
              <h2>AI provider</h2>
            </div>

            <div
              style={{
                padding: "16px 0 8px",
                borderBottom: "1px solid var(--border-subtle)",
              }}
            >
              <label
                htmlFor="ai-driver"
                style={{
                  display: "block",
                  fontSize: 13,
                  color: "var(--fg-1)",
                  marginBottom: 4,
                  fontWeight: 500,
                }}
              >
                Driver
              </label>
              <p
                style={{
                  fontSize: 12,
                  color: "var(--fg-2)",
                  margin: "0 0 10px",
                  lineHeight: 1.5,
                }}
              >
                Which AI provider to use for agent steps in recipes and
                orchestrated tasks. Changes are saved to the authoritative
                bridge config file and take effect after restarting the bridge.
              </p>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <select
                    id="ai-driver"
                    value={driverValue}
                    disabled={driverSaving}
                    onChange={(e) => {
                      setDriverValue(e.target.value);
                      setDriverSaveMsg(null);
                      setApiKeyInput("");
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
                      minWidth: 220,
                    }}
                  >
                    {DRIVER_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>

                {selectedKeyMeta && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 200 }}>
                    <label
                      htmlFor="api-key-input"
                      style={{ fontSize: 12, color: "var(--fg-2)" }}
                    >
                      {selectedKeyMeta.label}{" "}
                      <span style={{ color: "var(--fg-3)" }}>(leave blank to keep existing)</span>
                    </label>
                    <input
                      id="api-key-input"
                      type="password"
                      value={apiKeyInput}
                      onChange={(e) => {
                        setApiKeyInput(e.target.value);
                        setDriverSaveMsg(null);
                      }}
                      placeholder={selectedKeyMeta.placeholder}
                      style={{
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
                  </div>
                )}

                <button
                  type="button"
                  onClick={saveDriver}
                  disabled={driverSaving}
                  style={{
                    background: "var(--accent)",
                    color: "#fff",
                    border: "none",
                    borderRadius: "var(--r-2)",
                    padding: "6px 14px",
                    fontSize: 13,
                    cursor: driverSaving ? "not-allowed" : "pointer",
                    opacity: driverSaving ? 0.6 : 1,
                    whiteSpace: "nowrap",
                    alignSelf: "flex-end",
                  }}
                >
                  {driverSaving ? "Saving…" : "Save"}
                </button>
              </div>

              {driverSaveMsg && (
                <p
                  style={{
                    fontSize: 12,
                    marginTop: 6,
                    color: driverSaveMsg.ok ? "var(--ok)" : "var(--err)",
                  }}
                >
                  {driverSaveMsg.text}
                  {driverSaveMsg.restart && (
                    <span style={{ color: "var(--fg-2)", marginLeft: 6 }}>
                      Restart the bridge to apply.
                    </span>
                  )}
                </p>
              )}
            </div>
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

          <MobileNotificationsCard />
        </>
      )}
    </section>
  );
}

function MobileNotificationsCard() {
  const [status, setStatus] = useState<"idle" | "subscribing" | "subscribed" | "unsubscribing" | "unsupported">("idle");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setStatus("unsupported");
      return;
    }
    navigator.serviceWorker.getRegistration("/").then(async (reg) => {
      if (!reg) return;
      const sub = await reg.pushManager.getSubscription();
      if (sub) setStatus("subscribed");
    }).catch(() => {});
  }, []);

  async function handleSubscribe() {
    setStatus("subscribing");
    setMsg(null);
    try {
      const { subscribeToPush, registerServiceWorker } = await import("@/lib/pushSubscription");
      await registerServiceWorker();
      const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";
      if (!vapidKey) {
        setMsg({ ok: false, text: "NEXT_PUBLIC_VAPID_PUBLIC_KEY not set — contact your bridge admin." });
        setStatus("idle");
        return;
      }
      const ok = await subscribeToPush(vapidKey);
      setStatus(ok ? "subscribed" : "idle");
      setMsg(ok ? { ok: true, text: "Subscribed. You'll receive push notifications on this device." } : { ok: false, text: "Subscription failed — check Notification permission in browser settings." });
    } catch (err) {
      setStatus("idle");
      setMsg({ ok: false, text: String(err) });
    }
  }

  async function handleUnsubscribe() {
    setStatus("unsubscribing");
    setMsg(null);
    try {
      const { unsubscribeFromPush } = await import("@/lib/pushSubscription");
      await unsubscribeFromPush();
      setStatus("idle");
      setMsg({ ok: true, text: "Unsubscribed." });
    } catch (err) {
      setStatus("subscribed");
      setMsg({ ok: false, text: String(err) });
    }
  }

  async function handleTest() {
    setMsg(null);
    try {
      const res = await fetch(apiPath("/api/push/test"), { method: "POST" });
      const data = await res.json() as Record<string, unknown>;
      setMsg(res.ok ? { ok: true, text: `Test sent (${data.sent ?? 0} delivered).` } : { ok: false, text: JSON.stringify(data) });
    } catch (err) {
      setMsg({ ok: false, text: String(err) });
    }
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head">
        <h2>Mobile notifications</h2>
      </div>
      <div style={{ padding: "0 16px 16px" }}>
        <p style={{ fontSize: 13, color: "var(--fg-2)", marginBottom: 12 }}>
          Install this page as a PWA and receive push notifications when tool calls need your approval.
        </p>
        {status === "unsupported" ? (
          <p style={{ fontSize: 13, color: "var(--fg-3)" }}>Push notifications are not supported in this browser.</p>
        ) : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {status !== "subscribed" && status !== "unsubscribing" ? (
              <button
                type="button"
                onClick={handleSubscribe}
                disabled={status === "subscribing"}
                style={{ background: "var(--accent)", color: "#fff", border: "none", borderRadius: "var(--r-2)", padding: "8px 16px", fontSize: 13, cursor: status === "subscribing" ? "not-allowed" : "pointer", minHeight: 44 }}
              >
                {status === "subscribing" ? "Subscribing…" : "Enable push notifications"}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleTest}
                  style={{ background: "var(--bg-2)", color: "var(--fg-0)", border: "1px solid var(--border-default)", borderRadius: "var(--r-2)", padding: "8px 16px", fontSize: 13, cursor: "pointer", minHeight: 44 }}
                >
                  Test notification
                </button>
                <button
                  type="button"
                  onClick={handleUnsubscribe}
                  disabled={status === "unsubscribing"}
                  style={{ background: "transparent", color: "var(--fg-3)", border: "none", fontSize: 13, cursor: "pointer", minHeight: 44 }}
                >
                  {status === "unsubscribing" ? "Removing…" : "Remove this device"}
                </button>
              </>
            )}
          </div>
        )}
        {msg && (
          <p style={{ fontSize: 12, marginTop: 8, color: msg.ok ? "var(--ok)" : "var(--err)" }}>
            {msg.text}
          </p>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  pill,
}: {
  label: string;
  value: string;
  mono?: boolean;
  pill?: "ok" | "warn";
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
        alignItems: "center",
      }}
    >
      <span style={{ color: "var(--fg-2)" }}>{label}</span>
      <span
        className={mono ? "mono" : undefined}
        style={{ color: "var(--fg-0)", display: "flex", alignItems: "center", gap: 6 }}
      >
        {pill ? <span className={`pill ${pill}`} style={{ fontSize: 11 }}>{value}</span> : value}
      </span>
    </div>
  );
}
