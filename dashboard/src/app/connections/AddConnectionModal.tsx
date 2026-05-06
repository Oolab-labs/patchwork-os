"use client";
import { useState } from "react";
import { apiPath } from "@/lib/api";
import { Dialog } from "@/components/Dialog";

interface ConnectorStatus {
  id: string;
  status: "connected" | "disconnected" | "needs_reauth";
  lastSync?: string;
}

interface ProviderDef {
  id: string;
  name: string;
  description: string;
  icon: React.ComponentType;
}

interface Props {
  open: boolean;
  onClose: () => void;
  connectors: ConnectorStatus[];
  acting: string | null;
  onConnect: (id: string) => void;
  providers: ProviderDef[];
}

export default function AddConnectionModal({
  open,
  onClose,
  connectors,
  acting,
  onConnect,
  providers,
}: Props) {
  const [reqOpen, setReqOpen] = useState(false);
  const [reqName, setReqName] = useState("");
  const [reqNotes, setReqNotes] = useState("");
  const [reqSubmitting, setReqSubmitting] = useState(false);
  const [reqSuccess, setReqSuccess] = useState(false);
  const [reqError, setReqError] = useState<string | null>(null);

  function resetReqForm() {
    setReqOpen(false);
    setReqName("");
    setReqNotes("");
    setReqError(null);
    setReqSuccess(false);
  }

  async function handleReqSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!reqName.trim()) return;
    setReqSubmitting(true);
    setReqError(null);
    try {
      const res = await fetch(apiPath("/api/connector-requests"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: reqName.trim(),
          notes: reqNotes.trim() || undefined,
        }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) throw new Error(data.error ?? "Unknown error");
      setReqSuccess(true);
      setReqName("");
      setReqNotes("");
      setTimeout(() => {
        setReqSuccess(false);
        setReqOpen(false);
      }, 4000);
    } catch (err) {
      setReqError(err instanceof Error ? err.message : "Failed to submit");
    } finally {
      setReqSubmitting(false);
    }
  }

  function getStatus(id: string): ConnectorStatus["status"] {
    return connectors.find((c) => c.id === id)?.status ?? "disconnected";
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      ariaLabelledBy="add-connection-title"
      maxWidth={480}
      panelStyle={{ padding: 0, maxHeight: "min(80vh, calc(100vh - 32px))" }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "20px 20px 16px",
          borderBottom: "1px solid var(--line-1)",
          position: "sticky",
          top: 0,
          background: "var(--surface)",
          zIndex: 1,
        }}
      >
        <h2 id="add-connection-title" style={{ fontSize: "var(--fs-xl)", margin: 0 }}>
          Add connection
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--fg-2)",
            fontSize: "var(--fs-3xl)",
            lineHeight: 1,
            padding: "4px 6px",
            borderRadius: "var(--r-2)",
          }}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>

      <div style={{ padding: "8px 0 12px" }}>
        {providers.map(({ id, name, description, icon: Icon }, idx) => {
          const status = getStatus(id);
          const isActing = acting === id;
          return (
            <div
              key={id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 20px",
                borderBottom:
                  idx < providers.length - 1
                    ? "1px solid var(--line-1)"
                    : "none",
              }}
            >
              <div
                aria-hidden="true"
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: "var(--r-3)",
                  background: "var(--recess)",
                  border: "1px solid var(--line-2)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--fg-1)",
                  flexShrink: 0,
                }}
              >
                <Icon />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                    marginBottom: 2,
                  }}
                >
                  <span style={{ fontWeight: 600, fontSize: "var(--fs-m)", color: "var(--fg-0)" }}>
                    {name}
                  </span>
                  <span
                    className={`pill ${
                      status === "connected"
                        ? "ok"
                        : status === "needs_reauth"
                          ? "warn"
                          : "muted"
                    }`}
                    title={
                      status === "needs_reauth"
                        ? "Token expired — reconnect to restore access"
                        : undefined
                    }
                  >
                    {status === "connected" ? (
                      <>
                        <span className="pill-dot" />
                        Connected
                      </>
                    ) : status === "needs_reauth" ? (
                      <>
                        <span className="pill-dot" />
                        Reconnect required
                      </>
                    ) : (
                      "Not connected"
                    )}
                  </span>
                </div>
                <div
                  title={description}
                  style={{
                    fontSize: "var(--fs-s)",
                    color: "var(--fg-2)",
                    lineHeight: 1.4,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {description}
                </div>
              </div>
              <div style={{ flexShrink: 0 }}>
                {status === "connected" ? (
                  <button
                    type="button"
                    className="btn sm"
                    disabled
                    aria-label={`${name} already connected`}
                  >
                    Connected
                  </button>
                ) : status === "needs_reauth" ? (
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => onConnect(id)}
                    disabled={isActing}
                    aria-label={`Reconnect ${name}`}
                  >
                    {isActing ? "…" : "Reconnect"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn sm primary"
                    onClick={() => onConnect(id)}
                    disabled={isActing}
                    aria-label={`Connect ${name}`}
                  >
                    {isActing ? "…" : "Connect"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div
        style={{
          borderTop: "1px solid var(--line-1)",
          padding: "12px 20px 16px",
        }}
      >
        {!reqOpen && !reqSuccess && (
          <button
            type="button"
            onClick={() => setReqOpen(true)}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
              fontSize: "var(--fs-s)",
              color: "var(--fg-2)",
              textDecoration: "underline",
            }}
          >
            Don&apos;t see what you need? Request a connector
          </button>
        )}

        {reqSuccess && (
          <p role="status" style={{ fontSize: "var(--fs-s)", color: "var(--ok)", margin: 0 }}>
            <span aria-hidden="true">✓ </span>Request submitted. We&apos;ll add
            it to the roadmap.
          </p>
        )}

        {reqOpen && !reqSuccess && (
          <form
            onSubmit={handleReqSubmit}
            style={{ display: "flex", flexDirection: "column", gap: 8 }}
          >
            <input
              type="text"
              value={reqName}
              onChange={(e) => setReqName(e.target.value)}
              placeholder="Service name (e.g. Notion, HubSpot…)"
              maxLength={100}
              required
              aria-label="Service name"
              style={{
                width: "100%",
                padding: "6px 10px",
                fontSize: "var(--fs-m)",
                background: "var(--bg-1)",
                border: "1px solid var(--line-2)",
                borderRadius: "var(--r-2)",
                color: "var(--fg-0)",
                boxSizing: "border-box",
              }}
            />
            <textarea
              value={reqNotes}
              onChange={(e) => setReqNotes(e.target.value)}
              placeholder="Any notes? (optional)"
              maxLength={500}
              rows={3}
              aria-label="Notes"
              style={{
                width: "100%",
                padding: "6px 10px",
                fontSize: "var(--fs-m)",
                background: "var(--bg-1)",
                border: "1px solid var(--line-2)",
                borderRadius: "var(--r-2)",
                color: "var(--fg-0)",
                resize: "vertical",
                boxSizing: "border-box",
              }}
            />
            {reqError && (
              <p role="alert" style={{ fontSize: "var(--fs-s)", color: "var(--err)", margin: 0 }}>
                {reqError}
              </p>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                type="submit"
                className="btn sm primary"
                disabled={reqSubmitting || !reqName.trim()}
              >
                {reqSubmitting ? "Submitting…" : "Submit request"}
              </button>
              <button
                type="button"
                onClick={resetReqForm}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  fontSize: "var(--fs-s)",
                  color: "var(--fg-2)",
                  textDecoration: "underline",
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </Dialog>
  );
}
