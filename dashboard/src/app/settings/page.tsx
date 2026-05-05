"use client";
import { useEffect, useRef, useState } from "react";
import { fmtDuration } from "@/components/time";
import { apiPath } from "@/lib/api";
import { StatusPill } from "@/components/patchwork";

interface StatusResponse {
  uptimeMs?: number;
  claudeCode?: boolean;
  activeSessions?: number;
  extension?: boolean;
  patchwork?: {
    port?: number;
    workspace?: string;
    approvalGate?: string;
    enableTimeOfDayAnomaly?: boolean;
    fullMode?: boolean;
    driver?: string;
    model?: string;
    localEndpoint?: string;
    localModel?: string;
    automationEnabled?: boolean;
    webhookUrl?: string | null;
    pushServiceUrl?: string | null;
    pushServiceToken?: string | null;
    pushServiceBaseUrl?: string | null;
    inboxDir?: string;
    httpPort?: number;
    wsPort?: number;
    configPath?: string;
  };
  [k: string]: unknown;
}

type SectionId = "s-bridge" | "s-ai" | "s-approval" | "s-telemetry";

const NAV: { id: SectionId; label: string }[] = [
  { id: "s-bridge", label: "Bridge" },
  { id: "s-ai", label: "AI drivers" },
  { id: "s-approval", label: "Approval policy" },
  { id: "s-telemetry", label: "Telemetry" },
];

interface DriverRow {
  id: string;
  name: string;
  detail: string;
  driverValue: string; // bridge driver setting that maps to this row
}

const DRIVER_ROWS: DriverRow[] = [
  { id: "claude", name: "Claude 3.5 Sonnet", detail: "Anthropic · subprocess or API", driverValue: "subprocess" },
  { id: "gemini", name: "Gemini 2.5 Flash", detail: "Google · CLI or API", driverValue: "gemini" },
  { id: "ollama", name: "Ollama qwen2.5-coder", detail: "Local · Ollama / LM Studio", driverValue: "local" },
  { id: "openai", name: "OpenAI GPT-4o", detail: "OpenAI · requires API key", driverValue: "openai" },
];

const inputStyle = {
  background: "var(--bg-2)",
  border: "1px solid var(--border-default)",
  borderRadius: "var(--r-2)",
  color: "var(--fg-0)",
  fontSize: 13,
  fontFamily: "var(--font-mono)",
  padding: "6px 10px",
  outline: "none",
  width: "100%",
  boxSizing: "border-box" as const,
};

const labelStyle = {
  display: "block",
  fontSize: 13,
  color: "var(--fg-1)",
  marginBottom: 4,
  fontWeight: 500,
};

const helpStyle = {
  fontSize: 12,
  color: "var(--fg-2)",
  margin: "4px 0 0",
  lineHeight: 1.5,
};

export default function SettingsPage() {
  const [settings, setSettings] = useState<StatusResponse | null>(null);
  const [err, setErr] = useState<string>();
  const [unsupported, setUnsupported] = useState(false);
  const [active, setActive] = useState<SectionId>("s-bridge");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

  // Bridge form state
  const [workspacePath, setWorkspacePath] = useState("");
  const [inboxDir, setInboxDir] = useState("");
  const [httpPort, setHttpPort] = useState("3101");
  const [wsPort, setWsPort] = useState("3100");
  const bridgeInitialized = useRef(false);

  // AI drivers
  const [primaryDriver, setPrimaryDriver] = useState<string>("claude");
  const [driverSaving, setDriverSaving] = useState<string | null>(null);
  const [driverMsg, setDriverMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const driverInitialized = useRef(false);

  // Approval policy
  const [gateValue, setGateValue] = useState<"off" | "high" | "all">("off");
  const [gatePending, setGatePending] = useState<"off" | "high" | "all">("off");
  const [gateSaving, setGateSaving] = useState(false);
  const [gateSaveMsg, setGateSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const gateInitialized = useRef(false);

  const [todayAnomaly, setTodayAnomaly] = useState(false);
  const [todayAnomalySaving, setTodayAnomalySaving] = useState(false);
  const todayAnomalyInitialized = useRef(false);

  // CC permission rules (loaded from approval insights)
  const [permRules, setPermRules] = useState<{ allow: string[]; ask: string[]; deny: string[] } | null>(null);

  // Telemetry (local only — no backend yet)
  const [telCrash, setTelCrash] = useState(false);
  const [telUsage, setTelUsage] = useState(false);
  const [telDiag, setTelDiag] = useState(true);

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

        if (!bridgeInitialized.current) {
          setWorkspacePath(data.patchwork?.workspace ?? "");
          setInboxDir(data.patchwork?.inboxDir ?? "~/.patchwork/inbox");
          setHttpPort(String(data.patchwork?.httpPort ?? data.patchwork?.port ?? 3101));
          setWsPort(String(data.patchwork?.wsPort ?? 3100));
          bridgeInitialized.current = true;
        }
        if (!gateInitialized.current) {
          const g = data.patchwork?.approvalGate;
          const gv: "off" | "high" | "all" = g === "high" || g === "all" ? g : "off";
          setGateValue(gv);
          setGatePending(gv);
          gateInitialized.current = true;
        }
        if (!todayAnomalyInitialized.current) {
          setTodayAnomaly(Boolean(data.patchwork?.enableTimeOfDayAnomaly));
          todayAnomalyInitialized.current = true;
        }
        if (!driverInitialized.current) {
          const d = data.patchwork?.driver ?? "subprocess";
          const match = DRIVER_ROWS.find((r) => r.driverValue === d);
          setPrimaryDriver(match?.id ?? "claude");
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

  // Load CC permission rules for the approval policy section
  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const res = await fetch(apiPath("/api/cc-permissions"));
        if (!res.ok) return;
        const data = (await res.json()) as { allow?: string[]; ask?: string[]; deny?: string[] };
        if (cancel) return;
        setPermRules({
          allow: data.allow ?? [],
          ask: data.ask ?? [],
          deny: data.deny ?? [],
        });
      } catch {
        /* fail-soft */
      }
    })();
    return () => {
      cancel = true;
    };
  }, []);

  // Scroll-spy active section
  useEffect(() => {
    const handler = () => {
      const offsets = NAV.map((n) => {
        const el = document.getElementById(n.id);
        if (!el) return { id: n.id, top: Number.POSITIVE_INFINITY };
        return { id: n.id, top: Math.abs(el.getBoundingClientRect().top - 80) };
      });
      offsets.sort((a, b) => a.top - b.top);
      if (offsets[0]) setActive(offsets[0].id);
    };
    window.addEventListener("scroll", handler, { passive: true });
    handler();
    return () => window.removeEventListener("scroll", handler);
  }, []);

  function flashSaved() {
    setSaveState("saving");
    setTimeout(() => setSaveState("saved"), 600);
    setTimeout(() => setSaveState("idle"), 2400);
  }

  async function setPrimary(rowId: string) {
    const row = DRIVER_ROWS.find((r) => r.id === rowId);
    if (!row) return;
    setDriverSaving(rowId);
    setDriverMsg(null);
    try {
      const res = await fetch(apiPath("/api/bridge/settings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ driver: row.driverValue }),
      });
      if (res.ok) {
        setPrimaryDriver(rowId);
        setDriverMsg({ ok: true, text: `${row.name} set as primary.` });
        flashSaved();
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setDriverMsg({ ok: false, text: body.error ?? `Error ${res.status}` });
      }
    } catch (e) {
      setDriverMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setDriverSaving(null);
    }
  }

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
        flashSaved();
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setGateSaveMsg({ ok: false, text: body.error ?? `Error ${res.status}` });
      }
    } catch (e) {
      setGateSaveMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setGateSaving(false);
    }
  }

  async function saveTimeOfDayAnomaly(value: boolean) {
    setTodayAnomalySaving(true);
    try {
      const res = await fetch(apiPath("/api/bridge/settings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enableTimeOfDayAnomaly: value }),
      });
      if (res.ok) {
        setTodayAnomaly(value);
        flashSaved();
      }
    } catch {
      /* swallow */
    } finally {
      setTodayAnomalySaving(false);
    }
  }

  const configPath = settings?.patchwork?.configPath ?? "~/.patchwork/config.yaml";

  return (
    <section>
      <div
        className="page-head"
        style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}
      >
        <div>
          <h1 className="editorial-h1">
            Settings — <span className="accent">config that lives in plaintext.</span>
          </h1>
          <div className="editorial-sub">{configPath} · changes hot-reload</div>
        </div>
        <div
          aria-live="polite"
          aria-atomic="true"
          style={{
            fontSize: 12,
            color: saveState === "saved" ? "var(--ok)" : "var(--fg-2)",
            display: "flex",
            alignItems: "center",
            gap: 6,
            paddingTop: 8,
            minHeight: 16,
            transition: "color 0.2s, opacity 0.2s",
            opacity: saveState === "idle" ? 0 : 1,
          }}
        >
          {saveState !== "idle" && (
            <>
              <span aria-hidden style={{ fontSize: 13 }}>
                {saveState === "saved" ? "✓" : "…"}
              </span>
              {saveState === "saved" ? "Saved" : "Saving…"}
            </>
          )}
        </div>
      </div>

      {err && <div className="alert-err">Unreachable: {err}</div>}

      {unsupported ? (
        <div className="empty-state">
          <h3>Settings endpoint coming in next phase</h3>
          <p>
            This bridge version does not expose <code>/status</code>. Run <code>patchwork print-token</code> for
            connection details.
          </p>
        </div>
      ) : !settings ? (
        <div className="empty-state">
          <p>Loading…</p>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: "var(--s-5)", alignItems: "start" }}>
          {/* Sticky inner left nav */}
          <nav
            style={{
              position: "sticky",
              top: 24,
              display: "flex",
              flexDirection: "column",
              gap: 2,
              minHeight: "60vh",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1 }}>
              {NAV.map(({ id, label }) => {
                const isActive = active === id;
                return (
                  <a
                    key={id}
                    href={`#${id}`}
                    onClick={() => setActive(id)}
                    style={{
                      fontSize: 13,
                      fontWeight: isActive ? 600 : 500,
                      color: isActive ? "var(--ink-0)" : "var(--ink-2)",
                      background: isActive ? "var(--bg-2)" : "transparent",
                      textDecoration: "none",
                      padding: "6px 10px",
                      borderRadius: "var(--r-s)",
                      borderLeft: isActive ? "2px solid var(--accent)" : "2px solid transparent",
                      transition: "background 0.12s, color 0.12s",
                    }}
                  >
                    {label}
                  </a>
                );
              })}
            </div>
            <ConfigFileCard path={configPath} />
          </nav>

          <div>
            {/* Bridge */}
            <div id="s-bridge" className="card">
              <div className="card-head">
                <div>
                  <h2 style={{ margin: 0 }}>Bridge</h2>
                  <div style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 2 }}>
                    Runtime ports, workspace binding, inbox path
                  </div>
                </div>
                <StatusPill tone={settings.extension ? "ok" : "warn"}>
                  extension {settings.extension ? "connected" : "offline"}
                </StatusPill>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "16px 0 8px" }}>
                <div>
                  <label htmlFor="bridge-workspace" style={labelStyle}>
                    Workspace path
                  </label>
                  <input
                    id="bridge-workspace"
                    type="text"
                    value={workspacePath}
                    onChange={(e) => setWorkspacePath(e.target.value)}
                    placeholder="/Users/you/Projects/your-repo"
                    style={inputStyle}
                  />
                  <p style={helpStyle}>
                    Absolute path to the project Patchwork operates in. Tools resolve paths relative to this root.
                  </p>
                </div>

                <div>
                  <label htmlFor="bridge-inbox" style={labelStyle}>
                    Inbox directory
                  </label>
                  <input
                    id="bridge-inbox"
                    type="text"
                    value={inboxDir}
                    onChange={(e) => setInboxDir(e.target.value)}
                    placeholder="~/.patchwork/inbox"
                    style={inputStyle}
                  />
                  <p style={helpStyle}>
                    Where queued tasks, drafts, and pending approvals live on disk.
                  </p>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div>
                    <label htmlFor="bridge-http-port" style={labelStyle}>
                      HTTP port
                    </label>
                    <input
                      id="bridge-http-port"
                      type="number"
                      value={httpPort}
                      onChange={(e) => setHttpPort(e.target.value)}
                      placeholder="3101"
                      style={inputStyle}
                    />
                    <p style={helpStyle}>Dashboard + REST API listen here.</p>
                  </div>
                  <div>
                    <label htmlFor="bridge-ws-port" style={labelStyle}>
                      WebSocket port
                    </label>
                    <input
                      id="bridge-ws-port"
                      type="number"
                      value={wsPort}
                      onChange={(e) => setWsPort(e.target.value)}
                      placeholder="3100"
                      style={inputStyle}
                    />
                    <p style={helpStyle}>Claude Code IDE bridge transport.</p>
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button
                    type="button"
                    disabled
                    title="Editing not wired yet — change values in the config file below and restart the bridge."
                    aria-describedby="bridge-apply-help"
                    style={{
                      background: "var(--bg-2)",
                      color: "var(--fg-3)",
                      border: "1px solid var(--border-default)",
                      borderRadius: "var(--r-2)",
                      padding: "6px 14px",
                      fontSize: 13,
                      cursor: "not-allowed",
                      opacity: 0.6,
                    }}
                  >
                    Apply
                  </button>
                  <span id="bridge-apply-help" style={{ fontSize: 12, color: "var(--fg-3)" }}>
                    Read-only — edit the config file directly and restart the bridge.
                  </span>
                </div>
              </div>

              <div style={{ display: "flex", gap: 16, paddingTop: 12, borderTop: "1px solid var(--border-subtle)", fontSize: 12, color: "var(--fg-2)" }}>
                <span>Mode: <span style={{ color: "var(--fg-0)" }}>{settings.patchwork?.fullMode === false ? "slim" : "full"}</span></span>
                <span>Sessions: <span className="mono" style={{ color: "var(--fg-0)" }}>{settings.activeSessions ?? 0}</span></span>
                <span>Uptime: <span className="mono" style={{ color: "var(--fg-0)" }}>{settings.uptimeMs != null ? fmtDuration(settings.uptimeMs) : "—"}</span></span>
              </div>
            </div>

            {/* AI drivers */}
            <div id="s-ai" className="card" style={{ marginTop: 16 }}>
              <div className="card-head">
                <div>
                  <h2 style={{ margin: 0 }}>AI drivers</h2>
                  <div style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 2 }}>
                    Configure the models available for recipes and orchestrated tasks.
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "16px 0 4px" }}>
                {DRIVER_ROWS.map((row) => {
                  const isPrimary = primaryDriver === row.id;
                  const activeDriver = settings.patchwork?.driver === row.driverValue;
                  return (
                    <div
                      key={row.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: "12px 14px",
                        background: isPrimary ? "var(--bg-3)" : "var(--bg-2)",
                        border: isPrimary ? "1px solid var(--accent)" : "1px solid var(--border-default)",
                        borderRadius: "var(--r-2)",
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-0)" }}>{row.name}</span>
                          {isPrimary && <StatusPill tone="ok">primary</StatusPill>}
                          <StatusPill tone={activeDriver ? "ok" : "muted"}>
                            {activeDriver ? "active" : "inactive"}
                          </StatusPill>
                        </div>
                        <div style={{ fontSize: 12, color: "var(--fg-2)", marginTop: 2 }}>{row.detail}</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setPrimary(row.id)}
                        disabled={isPrimary || driverSaving === row.id}
                        style={{
                          background: "transparent",
                          color: "var(--fg-1)",
                          border: "1px solid var(--border-default)",
                          borderRadius: "var(--r-2)",
                          padding: "5px 10px",
                          fontSize: 12,
                          cursor: isPrimary ? "default" : "pointer",
                          opacity: isPrimary ? 0.5 : 1,
                        }}
                      >
                        {driverSaving === row.id ? "Saving…" : "Set primary"}
                      </button>
                      <button
                        type="button"
                        disabled
                        title="Per-driver configuration UI coming soon — edit the config file directly."
                        style={{
                          background: "transparent",
                          color: "var(--fg-3)",
                          border: "1px solid var(--border-default)",
                          borderRadius: "var(--r-2)",
                          padding: "5px 10px",
                          fontSize: 12,
                          cursor: "not-allowed",
                          opacity: 0.5,
                        }}
                      >
                        Configure
                      </button>
                    </div>
                  );
                })}
                {driverMsg && (
                  <p style={{ fontSize: 12, marginTop: 4, color: driverMsg.ok ? "var(--ok)" : "var(--err)" }}>
                    {driverMsg.text}
                  </p>
                )}
              </div>
            </div>

            {/* Approval policy */}
            <div id="s-approval" className="card" style={{ marginTop: 16 }}>
              <div className="card-head">
                <div>
                  <h2 style={{ margin: 0 }}>Approval policy</h2>
                  <div style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 2 }}>
                    Autopilot rules and Claude Code permission tiers.
                  </div>
                </div>
              </div>

              <div style={{ padding: "16px 0", borderBottom: "1px solid var(--border-subtle)" }}>
                <label htmlFor="delegation-policy" style={labelStyle}>
                  Delegation policy
                </label>
                <p style={helpStyle}>
                  Hold high-risk or all tool calls for review before execution. Takes effect for new sessions
                  immediately.
                </p>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
                  <select
                    id="delegation-policy"
                    value={gatePending}
                    disabled={gateSaving}
                    onChange={(e) => {
                      setGateSaveMsg(null);
                      setGatePending(e.target.value as "off" | "high" | "all");
                    }}
                    style={{ ...inputStyle, width: "auto", fontFamily: "inherit", cursor: "pointer" }}
                  >
                    <option value="off">off — no gating</option>
                    <option value="high">high — gate high-risk tools</option>
                    <option value="all">all — gate every tool call</option>
                  </select>
                  <button
                    type="button"
                    disabled={gateSaving || gatePending === gateValue}
                    onClick={() => saveGate(gatePending)}
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      padding: "6px 12px",
                      borderRadius: "var(--r-2)",
                      border: "none",
                      background: "var(--accent)",
                      color: "#fff",
                      cursor: gateSaving || gatePending === gateValue ? "default" : "pointer",
                      opacity: gateSaving || gatePending === gateValue ? 0.5 : 1,
                    }}
                  >
                    {gateSaving ? "Saving…" : "Save"}
                  </button>
                  {gateSaveMsg && (
                    <span style={{ fontSize: 12, color: gateSaveMsg.ok ? "var(--ok)" : "var(--err)" }}>
                      {gateSaveMsg.text}
                    </span>
                  )}
                </div>
              </div>

              <div style={{ padding: "16px 0", borderBottom: "1px solid var(--border-subtle)" }}>
                <label
                  htmlFor="time-of-day-anomaly"
                  style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 500, cursor: "pointer" }}
                >
                  <input
                    id="time-of-day-anomaly"
                    type="checkbox"
                    checked={todayAnomaly}
                    disabled={todayAnomalySaving}
                    onChange={(e) => saveTimeOfDayAnomaly(e.target.checked)}
                  />
                  Time-of-day anomaly signal
                </label>
                <p style={{ ...helpStyle, marginLeft: 24 }}>
                  Surfaces a chip on approvals when a tool runs outside your usual hours.
                </p>
              </div>

              <div style={{ padding: "16px 0" }}>
                <div style={labelStyle}>Claude Code permission rules</div>
                <p style={helpStyle}>
                  Mirrored from <code>~/.claude/settings.json</code>. Edit there to change.
                </p>
                {permRules ? (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginTop: 12 }}>
                    <PermColumn tone="ok" title="Allow" rules={permRules.allow} />
                    <PermColumn tone="warn" title="Ask" rules={permRules.ask} />
                    <PermColumn tone="err" title="Deny" rules={permRules.deny} />
                  </div>
                ) : (
                  <p style={{ ...helpStyle, marginTop: 10 }}>No permission data available.</p>
                )}
              </div>
            </div>

            {/* Telemetry */}
            <div id="s-telemetry" className="card" style={{ marginTop: 16 }}>
              <div className="card-head">
                <div>
                  <h2 style={{ margin: 0 }}>Telemetry</h2>
                  <div style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 2 }}>
                    Opt-in. Everything off by default. Local-only until you flip a switch.
                  </div>
                </div>
              </div>

              <div style={{ padding: "16px 0", display: "flex", flexDirection: "column", gap: 14 }}>
                <div role="status" style={{ fontSize: 12, color: "var(--fg-3)", marginBottom: 4 }}>
                  Preview only — toggles do not yet persist between reloads.
                </div>
                <ToggleRow
                  id="tel-crash"
                  label="Crash reports"
                  help="Send anonymized stack traces to help diagnose bridge crashes. No source files, no env vars."
                  checked={telCrash}
                  onChange={setTelCrash}
                />
                <ToggleRow
                  id="tel-usage"
                  label="Anonymous usage stats"
                  help="Tool-call counts and feature flag usage. No prompts, no file paths, no identifiers."
                  checked={telUsage}
                  onChange={setTelUsage}
                />
                <ToggleRow
                  id="tel-diag"
                  label="Local diagnostics retention"
                  help="Keep last 7 days of bridge logs on this machine for debugging. Never leaves your computer."
                  checked={telDiag}
                  onChange={setTelDiag}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function ToggleRow({
  id,
  label,
  help,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  help: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 2 }}
      />
      <label htmlFor={id} style={{ flex: 1, cursor: "pointer" }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-0)" }}>{label}</div>
        <div style={{ fontSize: 12, color: "var(--fg-2)", marginTop: 2, lineHeight: 1.5 }}>{help}</div>
      </label>
    </div>
  );
}

function PermColumn({
  tone,
  title,
  rules,
}: {
  tone: "ok" | "warn" | "err";
  title: string;
  rules: string[];
}) {
  return (
    <div
      style={{
        background: "var(--bg-2)",
        border: "1px solid var(--border-default)",
        borderRadius: "var(--r-2)",
        padding: 10,
        minHeight: 80,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <StatusPill tone={tone}>{title}</StatusPill>
        <span style={{ fontSize: 11, color: "var(--fg-3)" }}>{rules.length}</span>
      </div>
      {rules.length === 0 ? (
        <div style={{ fontSize: 11, color: "var(--fg-3)" }}>—</div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 3 }}>
          {rules.slice(0, 8).map((r) => (
            <li key={r} className="mono" style={{ fontSize: 11, color: "var(--fg-1)", wordBreak: "break-all" }}>
              {r}
            </li>
          ))}
          {rules.length > 8 && (
            <li style={{ fontSize: 11, color: "var(--fg-3)" }}>+{rules.length - 8} more</li>
          )}
        </ul>
      )}
    </div>
  );
}

function ConfigFileCard({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <div
      style={{
        marginTop: 16,
        background: "var(--bg-2)",
        border: "1px solid var(--border-default)",
        borderRadius: "var(--r-2)",
        padding: 10,
      }}
    >
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.05em", color: "var(--fg-3)", textTransform: "uppercase" }}>
        Config file
      </div>
      <div
        className="mono"
        style={{ fontSize: 11, color: "var(--fg-1)", marginTop: 6, wordBreak: "break-all", lineHeight: 1.4 }}
      >
        {path}
      </div>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy config path"
        style={{
          marginTop: 8,
          background: "transparent",
          border: "1px solid var(--border-default)",
          borderRadius: "var(--r-s)",
          color: copied ? "var(--ok)" : "var(--fg-1)",
          fontSize: 11,
          padding: "3px 8px",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        <span aria-hidden>{copied ? "✓" : "⧉"}</span>
        {copied ? "Copied" : "Copy path"}
      </button>
    </div>
  );
}
