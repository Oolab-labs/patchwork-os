"use client";
import { useRef, useEffect, useState } from "react";

interface ConnectorStatus {
  id: string;
  status: "connected" | "disconnected";
  lastSync?: string;
}

interface ConnectionsResponse {
  connectors: ConnectorStatus[];
}

// Icon components — inline SVG, no external deps

function IconEnvelope() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <rect
        x="2"
        y="4"
        width="16"
        height="12"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M2 7l8 5 8-5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconCalendar() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <rect
        x="2"
        y="4"
        width="16"
        height="14"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M6 2v4M14 2v4M2 9h16"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconGitHub() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M10 2a8 8 0 00-2.529 15.591c.4.074.546-.174.546-.386 0-.19-.007-.693-.01-1.36-2.226.483-2.695-1.073-2.695-1.073-.364-.924-.888-1.17-.888-1.17-.726-.496.055-.486.055-.486.803.056 1.226.824 1.226.824.713 1.221 1.872.869 2.328.664.072-.517.279-.869.508-1.069-1.776-.202-3.644-.888-3.644-3.953 0-.873.312-1.587.824-2.147-.083-.202-.357-1.016.078-2.117 0 0 .672-.215 2.2.82a7.67 7.67 0 012-.27c.679.003 1.363.092 2 .27 1.527-1.035 2.198-.82 2.198-.82.436 1.101.162 1.915.08 2.117.513.56.822 1.274.822 2.147 0 3.073-1.871 3.749-3.653 3.947.287.248.543.735.543 1.48 0 1.069-.01 1.932-.01 2.194 0 .214.144.463.55.385A8.001 8.001 0 0010 2z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconLinear() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path
        d="M3.5 13.207L6.793 16.5l9.207-9.207-3.293-3.293L3.5 13.207z"
        fill="currentColor"
        opacity="0.5"
      />
      <path
        d="M3 11.5L8.5 17l-5.5-5.5zM9 3l8 8-8-8z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M3.293 12.293l4.414 4.414L16.414 8l-4.414-4.414L3.293 12.293z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function IconSlack() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M7 10h6M10 7v6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ------------------------------------------------------------------ types

interface ConnectorCardProps {
  id: string;
  name: string;
  description: string;
  icon: React.ReactNode;
  status: "connected" | "disconnected";
  lastSync?: string;
  onConnect: () => void;
  onDisconnect: () => void;
  onTest: () => Promise<{ ok: boolean; message?: string }>;
  loading: boolean;
}

// ------------------------------------------------------------------ card

function ConnectorCard({
  id,
  name,
  description,
  icon,
  status,
  lastSync,
  onConnect,
  onDisconnect,
  onTest,
  loading,
}: ConnectorCardProps) {
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message?: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await onTest();
      setTestResult(r);
    } finally {
      setTesting(false);
    }
    // auto-clear after 4s
    setTimeout(() => setTestResult(null), 4000);
  }

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
        {/* Icon container */}
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: "var(--r-3)",
            background: "var(--bg-3)",
            border: "1px solid var(--border-default)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--fg-1)",
            flexShrink: 0,
          }}
          aria-hidden="true"
        >
          {icon}
        </div>

        {/* Name + description */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 4,
              flexWrap: "wrap",
            }}
          >
            <span style={{ fontWeight: 600, fontSize: 14, color: "var(--fg-0)" }}>
              {name}
            </span>
            <span className={`pill ${status === "connected" ? "ok" : "muted"}`}>
              {status === "connected" ? (
                <>
                  <span className="pill-dot" />
                  Connected
                </>
              ) : (
                "Not connected"
              )}
            </span>
          </div>
          <p style={{ fontSize: 13, color: "var(--fg-2)", lineHeight: 1.5 }}>
            {description}
          </p>
          {status === "connected" && lastSync && (
            <p style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 6 }}>
              Last synced{" "}
              <time dateTime={lastSync}>
                {new Date(lastSync).toLocaleString()}
              </time>
            </p>
          )}
        </div>

        {/* Action buttons */}
        <div style={{ display: "flex", gap: 8, flexShrink: 0, alignItems: "center" }}>
          {status === "connected" ? (
            <>
              <button
                type="button"
                className="btn sm"
                onClick={handleTest}
                disabled={testing || loading}
                aria-label={`Test ${name} connection`}
              >
                {testing ? "Testing…" : "Test connection"}
              </button>
              <button
                type="button"
                className="btn sm danger"
                onClick={onDisconnect}
                disabled={loading}
                aria-label={`Disconnect ${name}`}
              >
                {loading ? "…" : "Disconnect"}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn sm primary"
              onClick={onConnect}
              disabled={loading}
              aria-label={`Connect ${name}`}
            >
              {loading ? "…" : "Connect"}
            </button>
          )}
        </div>
      </div>

      {/* Test result feedback */}
      {testResult && (
        <div
          role="status"
          aria-live="polite"
          style={{
            marginTop: 12,
            padding: "8px 12px",
            borderRadius: "var(--r-2)",
            fontSize: 12,
            background: testResult.ok ? "var(--ok-soft)" : "var(--err-soft)",
            color: testResult.ok ? "var(--ok)" : "var(--err)",
          }}
        >
          {testResult.ok
            ? testResult.message ?? "Connection is working."
            : testResult.message ?? "Test failed — check bridge logs."}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ key modal

interface KeyModalProps {
  title: string;
  fields: { key: string; label: string; placeholder?: string; required?: boolean }[];
  onClose: () => void;
  onSubmit: (values: Record<string, string>) => Promise<void>;
}

function KeyModal({ title, fields, onClose, onSubmit }: KeyModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, ""])),
  );
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string>();

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) onClose();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setErr(undefined);
    try {
      await onSubmit(values);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
      setSubmitting(false);
    }
  }

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--border-default)",
          borderRadius: "var(--r-3)",
          padding: "var(--s-6)",
          minWidth: 360,
          maxWidth: 480,
          width: "100%",
          boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "var(--s-4)",
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "var(--fg-0)" }}>
            {title}
          </h2>
          <button
            type="button"
            className="btn sm ghost"
            onClick={onClose}
            aria-label="Close"
            style={{ padding: "0 var(--s-2)", fontSize: 16 }}
          >
            &#x2715;
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
            {fields.map((f) => (
              <div key={f.key}>
                <label
                  htmlFor={`key-modal-${f.key}`}
                  style={{
                    display: "block",
                    marginBottom: "var(--s-1)",
                    fontSize: 13,
                    fontWeight: 500,
                    color: "var(--fg-1)",
                  }}
                >
                  {f.label}
                  {f.required && <span style={{ color: "var(--err)", marginLeft: 4 }}>*</span>}
                </label>
                <input
                  id={`key-modal-${f.key}`}
                  type="text"
                  required={f.required}
                  value={values[f.key] ?? ""}
                  placeholder={f.placeholder ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  style={{
                    width: "100%",
                    background: "var(--bg-2)",
                    border: "1px solid var(--border-default)",
                    borderRadius: "var(--r-2)",
                    color: "var(--fg-0)",
                    fontSize: 13,
                    padding: "var(--s-2) var(--s-3)",
                    outline: "none",
                    fontFamily: "var(--font-mono)",
                  }}
                />
              </div>
            ))}
          </div>
          {err && (
            <div
              style={{
                marginTop: "var(--s-3)",
                fontSize: 12,
                color: "var(--err)",
              }}
            >
              {err}
            </div>
          )}
          <div
            style={{
              display: "flex",
              gap: "var(--s-3)",
              marginTop: "var(--s-5)",
              justifyContent: "flex-end",
            }}
          >
            <button type="button" className="btn ghost" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={submitting}>
              {submitting ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ placeholder

function PlaceholderCard({
  name,
  description,
  icon,
}: {
  name: string;
  description: string;
  icon: React.ReactNode;
}) {
  return (
    <div
      className="card"
      style={{ opacity: 0.5, pointerEvents: "none", userSelect: "none" }}
      aria-hidden="true"
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: "var(--r-3)",
            background: "var(--bg-3)",
            border: "1px solid var(--border-default)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--fg-3)",
            flexShrink: 0,
          }}
        >
          {icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 4,
            }}
          >
            <span style={{ fontWeight: 600, fontSize: 14, color: "var(--fg-1)" }}>
              {name}
            </span>
            <span className="pill muted">Coming soon</span>
          </div>
          <p style={{ fontSize: 13, color: "var(--fg-3)", lineHeight: 1.5 }}>
            {description}
          </p>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ page

export default function ConnectionsPage() {
  const [connectors, setConnectors] = useState<ConnectorStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string>();
  const [bridgeOffline, setBridgeOffline] = useState(false);
  // per-connector action loading state
  const [acting, setActing] = useState<string | null>(null);
  // inline action error
  const [actionErr, setActionErr] = useState<string | null>(null);

  async function fetchConnectors() {
    try {
      const res = await fetch("/api/connections");
      if (res.status === 503) {
        setBridgeOffline(true);
        setLoading(false);
        return;
      }
      if (!res.ok) throw new Error(`/api/connections ${res.status}`);
      const data = (await res.json()) as { connectors: ConnectorStatus[] };
      setConnectors(data.connectors ?? []);
      setBridgeOffline(false);
      setErr(undefined);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchConnectors();
  }, []);

  function getConnector(id: string): ConnectorStatus {
    return connectors.find((c) => c.id === id) ?? { id, status: "disconnected" };
  }

  function handleConnect(id: string) {
    // Open the OAuth auth URL in a new tab. The bridge handles the redirect.
    window.open(`/api/connections/${id}/auth`, "_blank", "noopener");
    // Poll for status update — the user will complete OAuth in the new tab.
    const poll = setInterval(async () => {
      const res = await fetch("/api/connections").catch(() => null);
      if (!res) return;
      const data = (await res.json().catch(() => null)) as {
        connectors: ConnectorStatus[];
      } | null;
      if (!data) return;
      const updated = data.connectors.find((c) => c.id === id);
      if (updated?.status === "connected") {
        setConnectors(data.connectors);
        clearInterval(poll);
      }
    }, 3000);
    // Stop polling after 2 minutes regardless
    setTimeout(() => clearInterval(poll), 120_000);
  }

  async function handleDisconnect(id: string) {
    setActing(id);
    setActionErr(null);
    try {
      const res = await fetch(`/api/connections/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setActionErr(body.error ?? `Error ${res.status}`);
        return;
      }
      setConnectors((prev) =>
        prev.map((c) => (c.id === id ? { ...c, status: "disconnected", lastSync: undefined } : c)),
      );
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    } finally {
      setActing(null);
    }
  }

  async function handleTest(id: string): Promise<{ ok: boolean; message?: string }> {
    try {
      const res = await fetch(`/api/connections/${id}/test`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        error?: string;
      };
      if (!res.ok) {
        return { ok: false, message: body.error ?? `Error ${res.status}` };
      }
      return { ok: body.ok !== false, message: body.message };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  const [keyModal, setKeyModal] = useState<string | null>(null);

  async function handleConnectWithKey(id: string, values: Record<string, string>) {
    setActing(id);
    setActionErr(null);
    try {
      const res = await fetch(`/api/connections/${id}/connect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || body.ok === false) {
        setActionErr(body.error ?? `Error ${res.status}`);
        return;
      }
      await fetchConnectors();
      setKeyModal(null);
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    } finally {
      setActing(null);
    }
  }

  const gmailConnector = getConnector("gmail");
  const githubConnector = getConnector("github");
  const linearConnector = getConnector("linear");
  const calendarConnector = getConnector("google-calendar");

  return (
    <section>
      {keyModal === "google-calendar" && (
        <KeyModal
          title="Connect Google Calendar"
          fields={[
            { key: "apiKey", label: "Google API Key", placeholder: "AIza…", required: true },
            { key: "calendarId", label: "Calendar ID", placeholder: "primary or user@gmail.com", required: true },
          ]}
          onClose={() => setKeyModal(null)}
          onSubmit={(values) => handleConnectWithKey("google-calendar", values)}
        />
      )}
      <div className="page-head">
        <div>
          <h1>Connections</h1>
          <div className="page-head-sub">
            Connect your accounts so Patchwork agents can read and act on your behalf.
          </div>
        </div>
      </div>

      {err && (
        <div className="alert-err" role="alert">
          {err}
        </div>
      )}

      {actionErr && (
        <div className="alert-err" role="alert">
          {actionErr}
        </div>
      )}

      {bridgeOffline ? (
        <div className="empty-state" role="status">
          <h3>Bridge offline</h3>
          <p>
            The bridge is not running. Start it with{" "}
            <code>patchwork start-all</code> then reload this page.
          </p>
        </div>
      ) : loading ? (
        <div className="empty-state" role="status" aria-busy="true">
          <p>Loading…</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Active connectors */}
          <ConnectorCard
            id="gmail"
            name="Gmail"
            description="Read and triage your inbox. Patchwork agents can summarise threads, draft replies, and label messages."
            icon={<IconEnvelope />}
            status={gmailConnector.status}
            lastSync={gmailConnector.lastSync}
            onConnect={() => handleConnect("gmail")}
            onDisconnect={() => handleDisconnect("gmail")}
            onTest={() => handleTest("gmail")}
            loading={acting === "gmail"}
          />

          <ConnectorCard
            id="github"
            name="GitHub"
            description="Read open issues and pull requests. Agents can surface blocking work items and review requests in your morning brief."
            icon={<IconGitHub />}
            status={githubConnector.status}
            lastSync={githubConnector.lastSync}
            onConnect={() => {
              window.open("https://cli.github.com", "_blank");
            }}
            onDisconnect={() => undefined}
            onTest={() => handleTest("github")}
            loading={acting === "github"}
          />

          <ConnectorCard
            id="linear"
            name="Linear"
            description="Read and manage issues. Agents can surface blocking work, summarise ticket context, and draft updates."
            icon={<IconLinear />}
            status={linearConnector.status}
            lastSync={linearConnector.lastSync}
            onConnect={() => handleConnect("linear")}
            onDisconnect={() => handleDisconnect("linear")}
            onTest={() => handleTest("linear")}
            loading={acting === "linear"}
          />

          <ConnectorCard
            id="google-calendar"
            name="Google Calendar"
            description="View your schedule. Agents can summarise upcoming meetings in your morning brief."
            icon={<IconCalendar />}
            status={calendarConnector.status}
            lastSync={calendarConnector.lastSync}
            onConnect={() => setKeyModal("google-calendar")}
            onDisconnect={() => handleDisconnect("google-calendar")}
            onTest={() => handleTest("google-calendar")}
            loading={acting === "google-calendar"}
          />
          <PlaceholderCard
            name="Slack"
            description="Monitor channels and threads. Agents can surface action items and draft responses."
            icon={<IconSlack />}
          />
        </div>
      )}
    </section>
  );
}
