"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiPath } from "@/lib/api";

// ------------------------------------------------------------------ types

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

// ------------------------------------------------------------------ modal

export default function AddConnectionModal({
  open,
  onClose,
  connectors,
  acting,
  onConnect,
  providers,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);

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
        body: JSON.stringify({ name: reqName.trim(), notes: reqNotes.trim() || undefined }),
      });
      const data = await res.json() as { ok: boolean; error?: string };
      if (!data.ok) throw new Error(data.error ?? "Unknown error");
      setReqSuccess(true);
      setReqName("");
      setReqNotes("");
      setTimeout(() => { setReqSuccess(false); setReqOpen(false); }, 4000);
    } catch (err) {
      setReqError(err instanceof Error ? err.message : "Failed to submit");
    } finally {
      setReqSubmitting(false);
    }
  }

  // Save trigger element before modal opens so we can return focus on close
  useEffect(() => {
    if (open) {
      triggerRef.current = document.activeElement;
    }
  }, [open]);

  // Escape key → close
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  // Focus first non-disabled button on open
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      const btn = panelRef.current?.querySelector<HTMLButtonElement>(
        "button:not([disabled])",
      );
      btn?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Lock body scroll
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
      // Return focus to trigger
      if (triggerRef.current instanceof HTMLElement) {
        triggerRef.current.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  function getStatus(id: string): ConnectorStatus["status"] {
    return connectors.find((c) => c.id === id)?.status ?? "disconnected";
  }

  const content = (
    <>
      {/* Scoped styles — no globals.css edit */}
      <style>{`
        .acm-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.5);
          z-index: 50;
        }
        .acm-panel {
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: min(480px, 90vw);
          max-height: 80vh;
          overflow-y: auto;
          background: var(--bg-2);
          border: 1px solid var(--border-default);
          border-radius: var(--r-4);
          z-index: 51;
          box-shadow: var(--shadow-2);
        }
        .acm-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 20px 20px 16px;
          border-bottom: 1px solid var(--border-subtle);
          position: sticky;
          top: 0;
          background: var(--bg-2);
          z-index: 1;
        }
        .acm-close {
          background: none;
          border: none;
          cursor: pointer;
          color: var(--fg-2);
          font-size: 20px;
          line-height: 1;
          padding: 4px 6px;
          border-radius: var(--r-2);
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .acm-close:hover {
          color: var(--fg-0);
          background: var(--bg-3);
        }
        .acm-list {
          padding: 8px 0 12px;
        }
        .acm-row {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 10px 20px;
        }
        .acm-row:not(:last-child) {
          border-bottom: 1px solid var(--border-subtle);
        }
        .acm-icon {
          width: 36px;
          height: 36px;
          border-radius: var(--r-3);
          background: var(--bg-3);
          border: 1px solid var(--border-default);
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--fg-1);
          flex-shrink: 0;
        }
        .acm-info {
          flex: 1;
          min-width: 0;
        }
        .acm-name-row {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          margin-bottom: 2px;
        }
        .acm-name {
          font-weight: 600;
          font-size: 13px;
          color: var(--fg-0);
        }
        .acm-desc {
          font-size: 12px;
          color: var(--fg-2);
          line-height: 1.4;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .acm-action {
          flex-shrink: 0;
        }
      `}</style>

      {/* Backdrop */}
      <div className="acm-backdrop" onClick={onClose} aria-hidden="true" />

      {/* Panel */}
      <div
        ref={panelRef}
        className="acm-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-connection-title"
      >
        <div className="acm-header">
          <h2 id="add-connection-title" style={{ fontSize: 16 }}>
            Add connection
          </h2>
          <button
            type="button"
            className="acm-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="acm-list">
          {providers.map(({ id, name, description, icon: Icon }) => {
            const status = getStatus(id);
            const isActing = acting === id;

            return (
              <div key={id} className="acm-row">
                {/* Icon */}
                <div className="acm-icon" aria-hidden="true">
                  <Icon />
                </div>

                {/* Info */}
                <div className="acm-info">
                  <div className="acm-name-row">
                    <span className="acm-name">{name}</span>
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
                  <div className="acm-desc" title={description}>
                    {description}
                  </div>
                </div>

                {/* Action */}
                <div className="acm-action">
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

        {/* Request a connector */}
        <div style={{ borderTop: "1px solid var(--border-subtle)", padding: "12px 20px 16px" }}>
          {!reqOpen && !reqSuccess && (
            <button
              type="button"
              onClick={() => setReqOpen(true)}
              style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 12, color: "var(--fg-2)", textDecoration: "underline" }}
            >
              Don't see what you need? Request a connector
            </button>
          )}

          {reqSuccess && (
            <p style={{ fontSize: 12, color: "var(--ok)", margin: 0 }}>
              ✓ Request submitted. We'll add it to the roadmap.
            </p>
          )}

          {reqOpen && !reqSuccess && (
            <form onSubmit={handleReqSubmit} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <input
                type="text"
                value={reqName}
                onChange={e => setReqName(e.target.value)}
                placeholder="Service name (e.g. Notion, HubSpot…)"
                maxLength={100}
                required
                style={{ width: "100%", padding: "6px 10px", fontSize: 13, background: "var(--bg-1)", border: "1px solid var(--border-default)", borderRadius: "var(--r-2)", color: "var(--fg-0)", boxSizing: "border-box" }}
              />
              <textarea
                value={reqNotes}
                onChange={e => setReqNotes(e.target.value)}
                placeholder="Any notes? (optional)"
                maxLength={500}
                rows={3}
                style={{ width: "100%", padding: "6px 10px", fontSize: 13, background: "var(--bg-1)", border: "1px solid var(--border-default)", borderRadius: "var(--r-2)", color: "var(--fg-0)", resize: "vertical", boxSizing: "border-box" }}
              />
              {reqError && (
                <p role="alert" style={{ fontSize: 12, color: "var(--err)", margin: 0 }}>{reqError}</p>
              )}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button type="submit" className="btn sm primary" disabled={reqSubmitting || !reqName.trim()}>
                  {reqSubmitting ? "Submitting…" : "Submit request"}
                </button>
                <button type="button" onClick={resetReqForm} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 12, color: "var(--fg-2)", textDecoration: "underline" }}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </>
  );

  return createPortal(content, document.body);
}
