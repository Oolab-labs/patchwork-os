"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiPath } from "@/lib/api";

interface ConnectorHealth {
  name: string;
  status: "connected" | "degraded" | "error" | "missing" | string;
  message?: string;
}

type StatusMap = Record<string, ConnectorHealth>;
type DotColor = "green" | "yellow" | "red" | "gray";

function resolveColor(status: string | undefined): DotColor {
  if (!status) return "gray";
  if (status === "connected") return "green";
  if (status === "degraded") return "yellow";
  if (status === "error" || status === "missing") return "red";
  return "gray";
}

function colorVar(color: DotColor): string {
  return color === "green"
    ? "var(--ok)"
    : color === "yellow"
      ? "var(--warn)"
      : color === "red"
        ? "var(--err)"
        : "var(--fg-3)";
}

function statusLabel(status: string | undefined): string {
  if (!status) return "Unknown";
  if (status === "connected") return "Connected";
  if (status === "degraded") return "Degraded";
  if (status === "error") return "Error";
  if (status === "missing") return "Not configured";
  return status;
}

function needsConnect(status: string | undefined): boolean {
  return status === "error" || status === "missing" || status === undefined;
}

interface Props {
  connectors: string[];
  /** Override the default top margin (var(--s-6)). Use 0 inside flex-gap layouts. */
  marginTop?: string | number;
}

export function ConnectorHealthPanel({ connectors, marginTop }: Props) {
  const [statusMap, setStatusMap] = useState<StatusMap | null>(null);
  const [fetchErr, setFetchErr] = useState<string>();

  async function load() {
    try {
      const res = await fetch(apiPath("/api/bridge/connectors/status"), {
        cache: "no-store",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setFetchErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as
        | ConnectorHealth[]
        | { connectors?: ConnectorHealth[] };
      const list: ConnectorHealth[] = Array.isArray(data)
        ? data
        : Array.isArray(
              (data as { connectors?: ConnectorHealth[] }).connectors,
            )
          ? (data as { connectors: ConnectorHealth[] }).connectors
          : [];
      const map: StatusMap = {};
      for (const c of list) {
        map[c.name.toLowerCase()] = c;
      }
      setStatusMap(map);
      setFetchErr(undefined);
    } catch (e) {
      setFetchErr(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (connectors.length === 0) return null;

  const total = connectors.length;
  const okCount = connectors.filter((n) => statusMap?.[n.toLowerCase()]?.status === "connected").length;
  const degCount = connectors.filter((n) => statusMap?.[n.toLowerCase()]?.status === "degraded").length;
  const errCount = connectors.filter((n) => {
    const s = statusMap?.[n.toLowerCase()]?.status;
    return s === "error" || s === "missing";
  }).length;

  return (
    <div
      className="glass-card"
      style={{ padding: "var(--s-5)", marginTop: marginTop ?? "var(--s-6)" }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "var(--s-3)",
          gap: "var(--s-3)",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s-2)" }}>
          <h3
            style={{
              margin: 0,
              fontSize: "var(--fs-xs)",
              color: "var(--ink-2)",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.07em",
            }}
          >
            Required connectors
          </h3>
          <span className="pill muted" style={{ fontSize: "var(--fs-2xs)" }}>{total}</span>
          {okCount > 0 && <span className="pill ok" style={{ fontSize: "var(--fs-2xs)" }}>{okCount} ok</span>}
          {degCount > 0 && <span className="pill warn" style={{ fontSize: "var(--fs-2xs)" }}>{degCount} degraded</span>}
          {errCount > 0 && <span className="pill err" style={{ fontSize: "var(--fs-2xs)" }}>{errCount} issue{errCount !== 1 ? "s" : ""}</span>}
        </div>
        {fetchErr && (
          <span style={{ fontSize: "var(--fs-xs)", color: "var(--err)" }}>{fetchErr}</span>
        )}
        {statusMap === null && !fetchErr && (
          <span style={{ fontSize: "var(--fs-xs)", color: "var(--fg-3)" }}>Loading…</span>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {connectors.map((name) => {
          const key = name.toLowerCase();
          const info = statusMap?.[key];
          const color = resolveColor(info?.status);
          const cssColor = colorVar(color);
          const label = statusLabel(info?.status);
          const showConnect = statusMap !== null && needsConnect(info?.status);

          return (
            <div
              key={name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--s-3)",
                padding: "7px 10px",
                borderRadius: "var(--r-s)",
                background: "var(--recess)",
                fontSize: "var(--fs-m)",
              }}
            >
              {/* Status dot — uses .connector-dot class + inline bg for color */}
              <span
                className="connector-dot"
                style={{ background: cssColor, width: 8, height: 8, fontSize: 0 }}
                aria-hidden="true"
              />
              <span
                style={{
                  flex: 1,
                  color: "var(--fg-1)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--fs-s)",
                }}
              >
                {name}
              </span>
              <span style={{ fontSize: "var(--fs-xs)", color: cssColor }}>{label}</span>
              {info?.message && (
                <span
                  style={{
                    fontSize: "var(--fs-xs)",
                    color: "var(--fg-3)",
                    marginLeft: "var(--s-1)",
                    maxWidth: 200,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={info.message}
                >
                  {info.message}
                </span>
              )}
              {showConnect && (
                <Link
                  href="/connections"
                  className="btn sm"
                  style={{ marginLeft: "auto", flexShrink: 0 }}
                >
                  Connect
                </Link>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
