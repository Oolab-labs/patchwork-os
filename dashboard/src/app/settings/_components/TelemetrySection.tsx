"use client";
import { useEffect, useRef, useState } from "react";
import { apiPath } from "@/lib/api";
import { ToggleRow } from "./ToggleRow";

/**
 * Telemetry settings section (`#s-telemetry`).
 *
 * Extracted from settings/page.tsx — fully self-contained: owns all
 * its own state + the GET/POST/DELETE against /api/bridge/telemetry-prefs.
 * The only thing it needs from the parent is `flashSaved` (the global
 * "Saved" toast). No `settings` slice — telemetry prefs live on their
 * own endpoint.
 */
export function TelemetrySection({ flashSaved }: { flashSaved: () => void }) {
  const [telCrash, setTelCrash] = useState(false);
  const [telUsage, setTelUsage] = useState(false);
  // Default false — the card subtitle says "Everything off by default".
  // `true` here flashed the toggle ON before the GET resolved,
  // misrepresenting the consent posture. Server is source of truth.
  const [telDiag, setTelDiag] = useState(false);
  const telInitialized = useRef(false);
  const [telLastSentAt, setTelLastSentAt] = useState<string | null>(null);
  const [telEndpoint, setTelEndpoint] = useState<string | null>(null);
  const [telEndpointSource, setTelEndpointSource] = useState<string | null>(
    null,
  );
  const [telResetBusy, setTelResetBusy] = useState(false);
  const [telResetMsg, setTelResetMsg] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  // Own AbortController so an in-flight optimistic save is cancelled if
  // the section unmounts. (The parent previously owned this ref.)
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    abortRef.current = new AbortController();
    return () => abortRef.current?.abort();
  }, []);

  // Load telemetry prefs on mount (once). Fail-soft — if bridge is offline
  // the toggles remain at their default values.
  //
  // Audit 2026-06-10 (dashboard-ui-1): a single fetch distributes all six
  // fields. Previously two independent mount effects hit the same endpoint, so
  // the endpoint info and the toggle values could reflect different server
  // snapshots when the bridge changed state mid-flight.
  useEffect(() => {
    if (telInitialized.current) return;
    let cancel = false;
    (async () => {
      try {
        const res = await fetch(apiPath("/api/bridge/telemetry-prefs"));
        if (!res.ok) return;
        const data = (await res.json()) as {
          lastSentAt?: string;
          endpoint?: string;
          endpointSource?: string;
          crashReports?: boolean;
          usageStats?: boolean;
          localDiagnostics?: boolean;
        };
        if (cancel) return;
        if (typeof data.lastSentAt === "string") {
          setTelLastSentAt(data.lastSentAt);
        }
        if (typeof data.endpoint === "string") {
          setTelEndpoint(data.endpoint);
        }
        if (typeof data.endpointSource === "string") {
          setTelEndpointSource(data.endpointSource);
        }
        if (typeof data.crashReports === "boolean")
          setTelCrash(data.crashReports);
        if (typeof data.usageStats === "boolean") setTelUsage(data.usageStats);
        if (typeof data.localDiagnostics === "boolean")
          setTelDiag(data.localDiagnostics);
        telInitialized.current = true;
      } catch {
        /* fail-soft — bridge may not be running */
      }
    })();
    return () => {
      cancel = true;
    };
  }, []);

  async function saveTelemetryPref(
    field: "crashReports" | "usageStats" | "localDiagnostics",
    value: boolean,
  ) {
    // Optimistic local update already applied by the caller via setter.
    try {
      await fetch(apiPath("/api/bridge/telemetry-prefs"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
        signal: abortRef.current?.signal,
      });
      flashSaved();
    } catch {
      /* fail-soft — UI already shows the optimistic value */
    }
  }

  async function resetTelemetryData() {
    if (
      !confirm(
        "Delete all local telemetry data?\n\nThis clears your saved preferences, the analytics endpoint config, and the install-identifying salt. Equivalent to a fresh install for telemetry purposes.",
      )
    ) {
      return;
    }
    setTelResetBusy(true);
    setTelResetMsg(null);
    try {
      const res = await fetch(apiPath("/api/bridge/telemetry-prefs"), {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setTelResetMsg({
          ok: false,
          text: body.error ?? `Error ${res.status}`,
        });
      } else {
        // Local state reset — server salt is gone, prefs reset to false.
        setTelCrash(false);
        setTelUsage(false);
        setTelDiag(false);
        setTelLastSentAt(null);
        setTelResetMsg({ ok: true, text: "Local telemetry data cleared." });
      }
    } catch (e) {
      setTelResetMsg({
        ok: false,
        text: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTelResetBusy(false);
    }
  }

  return (
    <div id="s-telemetry" className="card">
      <div className="card-head">
        <div>
          <h2 className="stg-card-h2">Telemetry</h2>
          <div className="stg-card-subtitle">
            Opt-in. Everything off by default. Local-only until you flip a
            switch.
          </div>
        </div>
      </div>

      <div className="stg-tel-list">
        <ToggleRow
          id="tel-crash"
          label="Crash reports"
          help="Send anonymized stack traces to help diagnose bridge crashes. No source files, no env vars."
          checked={telCrash}
          onChange={(v) => {
            setTelCrash(v);
            void saveTelemetryPref("crashReports", v);
          }}
        />
        <ToggleRow
          id="tel-usage"
          label="Anonymous usage stats"
          help="Tool-call counts and feature flag usage. No prompts, no file paths, no identifiers."
          checked={telUsage}
          onChange={(v) => {
            setTelUsage(v);
            void saveTelemetryPref("usageStats", v);
          }}
        />
        <ToggleRow
          id="tel-diag"
          label="Local diagnostics retention"
          help="Keep last 7 days of bridge logs on this machine for debugging. Never leaves your computer."
          checked={telDiag}
          onChange={(v) => {
            setTelDiag(v);
            void saveTelemetryPref("localDiagnostics", v);
          }}
        />
        {telLastSentAt && (
          <div className="stg-tel-meta">
            Last sent:{" "}
            {new Date(telLastSentAt).toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </div>
        )}
        {telEndpoint && (
          <div className="stg-tel-meta" aria-label="Telemetry destination">
            Sending to <span className="mono">{telEndpoint}</span>
            {telEndpointSource && (
              <span className="stg-tel-reset-note">
                {" "}
                (source: {telEndpointSource})
              </span>
            )}
          </div>
        )}
        <div className="stg-tel-footer">
          <button
            type="button"
            onClick={() => void resetTelemetryData()}
            disabled={telResetBusy}
            aria-label="Delete local telemetry data"
            className="stg-tel-reset-btn"
            data-busy={String(telResetBusy)}
          >
            {telResetBusy ? "Clearing…" : "Delete local telemetry data"}
          </button>
          <span className="stg-tel-reset-note">
            Clears prefs, endpoint config, and the install salt.
          </span>
          {telResetMsg && (
            <span
              className="stg-tel-reset-msg"
              data-ok={String(telResetMsg.ok)}
            >
              {telResetMsg.text}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
