"use client";
import { memo, useEffect, useRef, useState } from "react";
import { fmtDuration } from "@/components/time";
import { apiPath } from "@/lib/api";
import { subscribeStreamMessage } from "@/lib/streamLiveness";
import { EmptyState, StatusPill } from "@/components/patchwork";
import { ConfigFileCard } from "./_components/ConfigFileCard";
import { MobileSection } from "./_components/MobileSection";
import { PermColumn } from "./_components/PermColumn";
import { TelemetrySection } from "./_components/TelemetrySection";
import { ToggleRow } from "./_components/ToggleRow";
import { KillSwitchConfirmDialog } from "@/components/KillSwitchConfirmDialog";

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
    configPath?: string;
    apiKeysPresent?: {
      anthropic?: boolean;
      openai?: boolean;
      google?: boolean;
      xai?: boolean;
    };
  };
  [k: string]: unknown;
}

type ApiKeyProvider = "anthropic" | "openai" | "google" | "xai";

type SectionId =
  | "s-bridge"
  | "s-ai"
  | "s-approval"
  | "s-safety"
  | "s-mobile"
  | "s-telemetry";

const NAV: { id: SectionId; label: string }[] = [
  { id: "s-bridge", label: "Bridge" },
  { id: "s-ai", label: "AI drivers" },
  { id: "s-approval", label: "Approval policy" },
  { id: "s-safety", label: "Safety" },
  { id: "s-mobile", label: "Mobile" },
  { id: "s-telemetry", label: "Telemetry" },
];

interface DriverRow {
  id: string;
  name: string;
  detail: string;
  driverValue: string; // bridge driver setting that maps to this row
  keyProvider?: ApiKeyProvider; // shows API-key input when set
}

// Names omit model versions on purpose — versions go stale fast and the
// authoritative model id is already shown on /overview hero.
//
// "Claude" and "Claude API" are two real driver values (`subprocess` vs
// `api`) that hit Anthropic two different ways: Claude CLI subscription
// vs API key. Same split applies to Gemini (`gemini` vs `gemini-api`).
// Local LLM row drives a separate endpoint+model card (no key — local
// servers don't validate one).
//
// Subprocess rows (Claude, Gemini, Codex) authenticate via the CLI's own
// login (Claude Code subscription / Gemini CLI gcloud auth / `codex login`
// ChatGPT subscription) — they don't read an API key from env, so no
// keyProvider on those rows. Adding a key field there would mislead users
// into thinking it's required.
const DRIVER_ROWS: DriverRow[] = [
  { id: "claude", name: "Claude", detail: "Anthropic · Claude Code subscription (subprocess)", driverValue: "subprocess" },
  { id: "claude-api", name: "Claude API", detail: "Anthropic · API key (no subscription required)", driverValue: "api", keyProvider: "anthropic" },
  { id: "gemini", name: "Gemini", detail: "Google · CLI subscription (subprocess)", driverValue: "gemini" },
  { id: "gemini-api", name: "Gemini API", detail: "Google · API key (OpenAI-compatible endpoint)", driverValue: "gemini-api", keyProvider: "google" },
  { id: "codex", name: "Codex", detail: "OpenAI · ChatGPT subscription (subprocess)", driverValue: "codex" },
  { id: "openai", name: "OpenAI", detail: "API key required", driverValue: "openai", keyProvider: "openai" },
  { id: "grok", name: "Grok", detail: "xAI · API key required", driverValue: "grok", keyProvider: "xai" },
  { id: "local", name: "Local LLM", detail: "Ollama · LM Studio · vLLM · llama.cpp (OpenAI-compatible)", driverValue: "local" },
];

// Default model id each driver runs when input.model is not set.
// Source of truth (update when driver defaults move):
//   claude / claude-api → src/claudeDriver.ts:616, src/drivers/claude/api.ts:52
//   openai              → src/drivers/openai/index.ts:79 (literal fallback)
//   grok                → src/drivers/grok/index.ts:19 (defaultModel)
//   gemini-api          → src/drivers/gemini/api.ts:25 (defaultModel)
//   local               → src/drivers/local/index.ts:36 (env LOCAL_MODEL or fallback)
//   gemini              → no override; whatever the user's `gemini` CLI defaults to
//   codex               → no override; whatever the user's `codex` CLI defaults to
const DRIVER_DEFAULT_MODEL: Record<string, string | null> = {
  claude: "claude-haiku-4-5-20251001",
  "claude-api": "claude-haiku-4-5-20251001",
  openai: "gpt-4o",
  grok: "grok-2-latest",
  "gemini-api": "gemini-2.5-pro",
  local: null, // Reads from /status — see localEndpoint/localModel below
  gemini: null, // CLI default — not knowable without running it
  codex: null, // CLI default — not knowable without running it
};

export default function SettingsPage() {
  // Single AbortController per mount. Every user-initiated fetch passes
  // its signal; the cleanup effect calls .abort() on unmount, which
  // causes in-flight fetches to reject with `AbortError`. The catch
  // blocks recognise the error and short-circuit — no setState fires
  // after unmount, no "memory leak in unmounted component" warnings,
  // no out-of-order responses can corrupt state if the user navigates
  // away mid-save. Polling intervals (5s /status, SSE /stream) already
  // have their own cleanup so this only covers user-initiated POSTs.
  const abortRef = useRef<AbortController | null>(null);
  if (abortRef.current === null) abortRef.current = new AbortController();
  const flashTimer1Ref = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flashTimer2Ref = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const restartMsgTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      clearTimeout(flashTimer1Ref.current);
      clearTimeout(flashTimer2Ref.current);
      clearTimeout(restartMsgTimerRef.current);
    };
  }, []);
  const isAbortError = (e: unknown): boolean =>
    e instanceof DOMException && e.name === "AbortError";

  const [settings, setSettings] = useState<StatusResponse | null>(null);
  const [err, setErr] = useState<string>();
  const [unsupported, setUnsupported] = useState(false);
  const [active, setActive] = useState<SectionId>("s-bridge");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

  // Bridge form state
  const [workspacePath, setWorkspacePath] = useState("");
  const [inboxDir, setInboxDir] = useState("");
  const [httpPort, setHttpPort] = useState("3101");
  // Retained only for the 404 transient/initial distinction in the
  // /status tick. All field hydration is now poll-driven (see refs
  // below for fields where we still must guard against clobbering
  // user input).
  const bridgeInitialized = useRef(false);
  // Tracks whether the user has typed into the local-LLM endpoint or
  // model inputs since the last successful save. Polls skip the
  // setLocalEndpoint / setLocalModel updates while dirty so they
  // don't clobber an in-progress edit.
  const localDirtyRef = useRef(false);
  // Mirrors of gateValue + gatePending so the /status tick can decide
  // whether the user's draft is still in sync with the server (auto-
  // adopt new value) or diverged (leave draft alone).
  const gateValueRef = useRef<"off" | "high" | "all">("off");
  const gatePendingRef = useRef<"off" | "high" | "all">("off");

  // AI drivers
  const [primaryDriver, setPrimaryDriver] = useState<string>("claude");
  const [driverSaving, setDriverSaving] = useState<string | null>(null);
  const [driverMsg, setDriverMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [restartPending, setRestartPending] = useState(false);
  const [restartBusy, setRestartBusy] = useState(false);
  const [restartMsg, setRestartMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Per-row API key entry state. Inputs are uncontrolled w.r.t. /status —
  // the dashboard never sees the stored value (secure store is one-way),
  // so this map only tracks the current draft text.
  const [keyDrafts, setKeyDrafts] = useState<Record<ApiKeyProvider, string>>({
    anthropic: "",
    openai: "",
    google: "",
    xai: "",
  });
  const [keySaving, setKeySaving] = useState<ApiKeyProvider | null>(null);
  const [keyMsg, setKeyMsg] = useState<{ provider: ApiKeyProvider; ok: boolean; text: string } | null>(null);

  // Local LLM endpoint + model. Drafted in the form; pushed via POST
  // {model:"local", localEndpoint, localModel} which writes to ~/.patchwork
  // and (on bridge restart) seeds LOCAL_ENDPOINT/LOCAL_MODEL env vars that
  // LocalApiDriver reads.
  const [localEndpoint, setLocalEndpoint] = useState("");
  const [localModel, setLocalModel] = useState("");
  const [localSaving, setLocalSaving] = useState(false);
  const [localMsg, setLocalMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Approval policy
  const [gateValue, setGateValue] = useState<"off" | "high" | "all">("off");
  const [gatePending, setGatePending] = useState<"off" | "high" | "all">("off");
  const [gateSaving, setGateSaving] = useState(false);
  const [gateSaveMsg, setGateSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [todayAnomaly, setTodayAnomaly] = useState(false);
  const [todayAnomalySaving, setTodayAnomalySaving] = useState(false);
  const [todayAnomalyErr, setTodayAnomalyErr] = useState<string | null>(null);

  // CC permission rules (loaded from approval insights)
  const [permRules, setPermRules] = useState<{ allow: string[]; ask: string[]; deny: string[] } | null>(null);

  // Mobile / Web Push section extracted to ./_components/MobileSection.tsx.

  // Telemetry section state + handlers extracted to
  // ./_components/TelemetrySection.tsx — it owns its own endpoint.

  // Kill-switch state — fetched from /api/bridge/kill-switch (proxy to
  // bridge `GET /kill-switch`). Polls in tandem with /status below.
  // Issue #422 step 6.
  const [ksEngaged, setKsEngaged] = useState(false);
  const [ksLocked, setKsLocked] = useState(false);
  const [ksLockedReason, setKsLockedReason] = useState<string | undefined>();
  const [ksSaving, setKsSaving] = useState(false);
  const [ksMsg, setKsMsg] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  // Confirm-dialog gate in front of the POST below (dashboard-killswitch-confirm).
  // `ksConfirmValue` holds the pending target state (true=engage, false=release)
  // while the dialog is open; null means no confirm in flight.
  const [ksConfirmValue, setKsConfirmValue] = useState<boolean | null>(null);

  useEffect(() => {
    const tick = async () => {
      try {
        const res = await fetch(apiPath("/api/bridge/status"));
        if (res.status === 404) {
          // Only collapse to "unsupported" empty state if we have NEVER
          // successfully loaded settings. Once initialized, treat 404 as a
          // transient error so a single hiccup doesn't wipe the whole page.
          if (!bridgeInitialized.current) {
            setUnsupported(true);
          } else {
            setErr(`/status 404`);
          }
          return;
        }
        if (!res.ok) throw new Error(`/status ${res.status}`);
        const data = (await res.json()) as StatusResponse;
        // Recovered: clear the transient unsupported flag so the UI heals.
        setUnsupported(false);
        setSettings(data);
        setErr(undefined);

        // Previously every form field was one-shot-latched against the
        // first /status response, so out-of-band changes (CLI edit,
        // second dashboard tab, kill-switch flip) were invisible until
        // a full page reload. Always sync read-only and selection
        // fields. For text inputs (localEndpoint/localModel) and the
        // pending-gate draft, only sync when the user has NOT touched
        // the field (`localDirty` / `gatePending === gateValue`) so we
        // don't clobber an in-progress edit.
        setWorkspacePath(data.patchwork?.workspace ?? "");
        setInboxDir(data.patchwork?.inboxDir ?? "~/.patchwork/inbox");
        setHttpPort(
          String(
            data.patchwork?.httpPort ?? data.patchwork?.port ?? 3101,
          ),
        );

        const g = data.patchwork?.approvalGate;
        const gv: "off" | "high" | "all" =
          g === "high" || g === "all" ? g : "off";
        const prevGateValue = gateValueRef.current;
        gateValueRef.current = gv;
        setGateValue(gv);
        // If the user's draft equals the previous server value (i.e.
        // they haven't picked a different option since last sync), keep
        // it in lock-step with the new server value. Otherwise leave
        // their draft alone — they're mid-edit.
        if (gatePendingRef.current === prevGateValue) {
          setGatePending(gv);
        }

        setTodayAnomaly(Boolean(data.patchwork?.enableTimeOfDayAnomaly));

        if (!localDirtyRef.current) {
          setLocalEndpoint(data.patchwork?.localEndpoint ?? "");
          setLocalModel(data.patchwork?.localModel ?? "");
        }

        const d = data.patchwork?.driver ?? "subprocess";
        const match = DRIVER_ROWS.find((r) => r.driverValue === d);
        setPrimaryDriver(match?.id ?? "claude");
        // Mark first-load done so a subsequent 404 is treated as
        // transient (don't blow away the form), not "feature missing"
        // (collapse to empty-state).
        bridgeInitialized.current = true;

        // Kill-switch state poll — parallel to /status, same cadence.
        // 404 means the endpoint isn't deployed yet (pre-#422 bridge);
        // treat as "feature not available" and leave defaults.
        try {
          const ksRes = await fetch(apiPath("/api/bridge/kill-switch"));
          if (ksRes.ok) {
            const ks = (await ksRes.json()) as {
              engaged?: boolean;
              locked?: boolean;
              lockedReason?: string;
            };
            setKsEngaged(Boolean(ks.engaged));
            setKsLocked(Boolean(ks.locked));
            setKsLockedReason(ks.lockedReason);
          }
        } catch {
          // Transient — leave previous state in place.
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, []);

  // v2-I8 (#422): SSE consumer for kind:"kill-switch" events from /stream.
  // Subscribes via the shared singleton (#700) — one socket per tab
  // serves the kill-switch listener, /activity, the LiveRuns store,
  // and the header liveness pip. Singleton owns reconnect/backoff.
  useEffect(() => {
    return subscribeStreamMessage((type, raw) => {
      if (type !== "kill-switch") return;
      const evt = raw as { engaged?: boolean } | null;
      if (evt && typeof evt.engaged === "boolean") {
        setKsEngaged(evt.engaged);
      }
    });
  }, []);

  // Load CC permission rules for the approval policy section
  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const res = await fetch(apiPath("/api/bridge/cc-permissions"));
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

  // Scroll-spy active section — rAF-throttled. Previously
  // `getBoundingClientRect()` ×6 fired on every scroll event,
  // forcing synchronous layout each tick and showing visible jank on
  // long pages. Coalesce to at most one measurement per animation
  // frame; the visual result is identical.
  useEffect(() => {
    let pending = false;
    const measure = () => {
      pending = false;
      const offsets = NAV.map((n) => {
        const el = document.getElementById(n.id);
        if (!el) return { id: n.id, top: Number.POSITIVE_INFINITY };
        return { id: n.id, top: Math.abs(el.getBoundingClientRect().top - 80) };
      });
      offsets.sort((a, b) => a.top - b.top);
      if (offsets[0]) setActive(offsets[0].id);
    };
    const handler = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(measure);
    };
    window.addEventListener("scroll", handler, { passive: true });
    measure();
    return () => window.removeEventListener("scroll", handler);
  }, []);

  function flashSaved() {
    setSaveState("saving");
    clearTimeout(flashTimer1Ref.current);
    clearTimeout(flashTimer2Ref.current);
    flashTimer1Ref.current = setTimeout(() => setSaveState("saved"), 600);
    flashTimer2Ref.current = setTimeout(() => setSaveState("idle"), 2400);
  }

  async function saveApiKey(provider: ApiKeyProvider, explicitKey?: string) {
    // Audit 2026-05-17 (#600): reading keyDrafts[provider] from closure
    // is stale when the Clear button queues setKeyDrafts("") immediately
    // before calling this — React batches state updates, so the OLD key
    // gets re-saved instead of cleared. Accept an explicit value to
    // bypass the closure for callers that already know the intended key.
    const key = explicitKey !== undefined ? explicitKey : keyDrafts[provider];
    setKeySaving(provider);
    setKeyMsg(null);
    try {
      const res = await fetch(apiPath("/api/bridge/settings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: { provider, key } }),
        signal: abortRef.current?.signal,
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok) {
        setKeyDrafts((d) => ({ ...d, [provider]: "" }));
        setKeyMsg({ provider, ok: true, text: key ? "Key saved." : "Key cleared." });
        flashSaved();
        // Refresh /status so the "key set" badge reflects the change immediately.
        try {
          const refreshed = await (await fetch(apiPath("/api/bridge/status"), {
            signal: abortRef.current?.signal,
          })).json();
          setSettings(refreshed);
        } catch {
          /* badge will update on next poll tick */
        }
      } else {
        setKeyMsg({ provider, ok: false, text: body.error ?? `Error ${res.status}` });
      }
    } catch (e) {
      if (isAbortError(e)) return;
      setKeyMsg({ provider, ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setKeySaving(null);
    }
  }

  async function saveLocalConfig() {
    if (!localEndpoint.trim()) {
      setLocalMsg({ ok: false, text: "Endpoint URL is required." });
      return;
    }
    setLocalSaving(true);
    setLocalMsg(null);
    try {
      // model:"local" is required by the bridge handler to accept localEndpoint
      // and localModel writes ([src/server.ts:1371-1376] gates them on this).
      const res = await fetch(apiPath("/api/bridge/settings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "local",
          localEndpoint: localEndpoint.trim(),
          localModel: localModel.trim(),
        }),
        signal: abortRef.current?.signal,
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        restartRequired?: boolean;
        error?: string;
      };
      if (res.ok) {
        const text = body.restartRequired
          ? "Saved. Restart Claude Code (quit and re-open, then /ide) to activate."
          : "Saved.";
        setLocalMsg({ ok: true, text });
        // Clear dirty so future polls re-sync the field — picks up
        // any out-of-band edits made after this save.
        localDirtyRef.current = false;
        flashSaved();
      } else {
        setLocalMsg({ ok: false, text: body.error ?? `Error ${res.status}` });
      }
    } catch (e) {
      if (isAbortError(e)) return;
      setLocalMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setLocalSaving(false);
    }
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
        signal: abortRef.current?.signal,
      });
      // Always read body — both success and error responses carry useful info
      // (e.g. `restartRequired` flag on success, `error` text on failure).
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        restartRequired?: boolean;
        error?: string;
      };
      if (res.ok) {
        setPrimaryDriver(rowId);
        if (body.restartRequired) {
          setRestartPending(true);
          setDriverMsg({ ok: true, text: `${row.name} set as primary. Click "Restart Bridge" below to activate.` });
        } else {
          setDriverMsg({ ok: true, text: `${row.name} set as primary.` });
        }
        flashSaved();
      } else {
        setDriverMsg({ ok: false, text: body.error ?? `Error ${res.status}` });
      }
    } catch (e) {
      if (isAbortError(e)) return;
      setDriverMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setDriverSaving(null);
    }
  }

  async function restartBridge() {
    setRestartBusy(true);
    setRestartMsg(null);
    try {
      const res = await fetch(apiPath("/api/bridge/restart"), {
        method: "POST",
        signal: abortRef.current?.signal,
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        error?: string;
        reason?: string;
        inFlightCalls?: number;
        busySessions?: string[];
      };
      if (res.ok) {
        setRestartPending(false);
        setRestartMsg({ ok: true, text: body.message ?? "Bridge is restarting..." });
        // Clear the message after a few seconds since the page will reload
        clearTimeout(restartMsgTimerRef.current);
        restartMsgTimerRef.current = setTimeout(() => setRestartMsg(null), 3000);
      } else if (res.status === 409) {
        // Restart blocked due to active work
        const busyDetails = body.busySessions?.length
          ? `\n\nBusy sessions:\n${body.busySessions.join("\n")}`
          : "";
        setRestartMsg({
          ok: false,
          text: `${body.reason ?? "Restart blocked"}${busyDetails}`,
        });
      } else {
        setRestartMsg({ ok: false, text: body.error ?? `Error ${res.status}` });
      }
    } catch (e) {
      if (isAbortError(e)) return;
      setRestartMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setRestartBusy(false);
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
        signal: abortRef.current?.signal,
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
      if (isAbortError(e)) return;
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
        signal: abortRef.current?.signal,
      });
      if (res.ok) {
        setTodayAnomaly(value);
        setTodayAnomalyErr(null);
        flashSaved();
      } else {
        // Audit 2026-05-17 (#600): previously swallowed all failures
        // silently, including non-OK responses. Toggle would visually
        // flip but persist nothing — silent data-loss class. Now surface
        // via the same error-message slot the kill-switch row uses.
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setTodayAnomalyErr(body.error ?? `Save failed (HTTP ${res.status})`);
      }
    } catch (e) {
      if (isAbortError(e)) return;
      setTodayAnomalyErr(e instanceof Error ? e.message : String(e));
    } finally {
      setTodayAnomalySaving(false);
    }
  }

  const configPath = settings?.patchwork?.configPath ?? "~/.patchwork/config.json";

  return (
    <section>
      <div className="page-head stg-page-head">
        <div>
          <h1 className="editorial-h1">
            Settings — <span className="accent">how Patchwork runs</span>
          </h1>
          <div className="editorial-sub">
            <span title={configPath}>settings file</span> · changes apply automatically
          </div>
        </div>
        <div
          aria-live="polite"
          aria-atomic="true"
          className="stg-save-indicator"
          data-state={saveState}
        >
          {saveState !== "idle" && (
            <>
              {saveState === "saved" ? (
                <span aria-hidden className="stg-save-icon stg-save-icon-check">✓</span>
              ) : (
                <span aria-hidden className="stg-save-icon">…</span>
              )}
              {saveState === "saved" ? "Saved" : "Saving…"}
            </>
          )}
        </div>
      </div>

      {err && <div className="alert-err" role="alert">Unreachable: {err}</div>}

      {unsupported ? (
        <EmptyState
          title="Settings endpoint coming in next phase"
          description={
            <>
              This bridge version does not expose <code>/status</code>. Run <code>patchwork print-token</code> for
              connection details.
            </>
          }
        />
      ) : (
        // Render the full form even when /status hasn't loaded yet. Bridge-
        // independent cards (Mobile, Telemetry) work without it; bridge-
        // dependent cards (Bridge, AI drivers, Approval) show their state
        // hooks' defaults until /status responds. Previous behavior gated
        // every card behind `!settings ? Loading…` which made the Mobile
        // section unreachable when the dashboard couldn't talk to the
        // bridge — exactly when the operator most needs to enable phone
        // notifications.
        <div className="settings-grid">
          {/* Sticky inner left nav */}
          <nav className="stg-nav">
            <div className="stg-nav-list">
              <SettingsNavList active={active} onSelect={setActive} />
            </div>
            <ConfigFileCard path={configPath} />
          </nav>

          <div className="stg-main-col">
            {/* Bridge */}
            <div id="s-bridge" className="card">
              <div className="card-head">
                <div>
                  <h2 className="stg-card-h2">Bridge</h2>
                  <div className="stg-card-subtitle">
                    Runtime ports, workspace binding, inbox path
                  </div>
                </div>
                <StatusPill tone={settings?.extension ? "ok" : "warn"}>
                  extension {settings?.extension ? "connected" : "offline"}
                </StatusPill>
              </div>

              <div className="stg-form-fields">
                <div>
                  <label htmlFor="bridge-workspace" className="stg-label">
                    Workspace path
                  </label>
                  <input
                    id="bridge-workspace"
                    type="text"
                    value={workspacePath}
                    readOnly
                    placeholder="/Users/you/Projects/your-repo"
                    className="stg-input stg-input-readonly"
                  />
                  <p className="stg-help">
                    Absolute path to the project Patchwork operates in. Tools resolve paths relative to this root.
                  </p>
                </div>

                <div>
                  <label htmlFor="bridge-inbox" className="stg-label">
                    Inbox directory
                  </label>
                  <input
                    id="bridge-inbox"
                    type="text"
                    value={inboxDir}
                    readOnly
                    placeholder="~/.patchwork/inbox"
                    className="stg-input stg-input-readonly"
                  />
                  <p className="stg-help">
                    Where queued tasks, drafts, and pending approvals live on disk.
                  </p>
                </div>

                <div>
                  <label htmlFor="bridge-port" className="stg-label">
                    Bridge port
                  </label>
                  <input
                    id="bridge-port"
                    type="number"
                    value={httpPort}
                    readOnly
                    placeholder="3101"
                    className="stg-input stg-input-readonly"
                  />
                  <p className="stg-help">
                    REST API, dashboard, and Claude Code WebSocket transport all share this port.
                  </p>
                </div>

                <div
                  className="stg-readonly-note"
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}
                >
                  <span>Read-only — changes here need a restart.</span>
                  <button
                    type="button"
                    className="stg-action-btn"
                    title={configPath}
                    onClick={() => {
                      let opened = false;
                      try {
                        const win = window.open(`file://${configPath}`, "_blank");
                        opened = !!win;
                      } catch {
                        opened = false;
                      }
                      if (!opened && navigator.clipboard?.writeText) {
                        navigator.clipboard
                          .writeText(configPath)
                          .catch(() => {
                            /* clipboard unavailable — title attr still shows the path */
                          });
                      }
                    }}
                  >
                    Open config file
                  </button>
                </div>
              </div>

              <div className="stg-stats-bar">
                <span>Mode: <span className="stg-stat-val">{settings?.patchwork?.fullMode === false ? "slim" : "full"}</span></span>
                <span>Sessions: <span className="mono stg-stat-val">{settings?.activeSessions ?? 0}</span></span>
                <span>Uptime: <span className="mono stg-stat-val">{settings?.uptimeMs != null ? fmtDuration(settings.uptimeMs) : "—"}</span></span>
              </div>
            </div>

            {/* AI drivers */}
            <div id="s-ai" className="card">
              <div className="card-head">
                <div>
                  <h2 className="stg-card-h2">AI drivers</h2>
                  <div className="stg-card-subtitle">
                    Configure the models available for recipes and orchestrated tasks.
                  </div>
                </div>
              </div>

              <div className="stg-driver-list">
                {DRIVER_ROWS.map((row) => {
                  const isPrimary = primaryDriver === row.id;
                  const activeDriver = settings?.patchwork?.driver === row.driverValue;
                  // When the row is the optimistic "primary" but the bridge
                  // hasn't switched yet, surface that as a clear pending-restart
                  // state instead of the contradictory `primary` + `inactive`.
                  const pendingRestart = isPrimary && !activeDriver;
                  const provider = row.keyProvider;
                  const keyPresent = provider
                    ? Boolean(settings?.patchwork?.apiKeysPresent?.[provider])
                    : false;
                  return (
                    <div
                      key={row.id}
                      className="stg-driver-row"
                      data-primary={String(isPrimary)}
                    >
                      <div className="stg-driver-row-header">
                        <div className="stg-driver-meta">
                          <div className="stg-driver-name-row">
                            <span className="stg-driver-name">{row.name}</span>
                            {isPrimary && <StatusPill tone="ok">primary</StatusPill>}
                            {pendingRestart ? (
                              <StatusPill tone="warn">pending restart</StatusPill>
                            ) : (
                              <StatusPill tone={activeDriver ? "ok" : "muted"}>
                                {activeDriver ? "active" : "inactive"}
                              </StatusPill>
                            )}
                            {provider && keyPresent && (
                              <StatusPill tone="ok">key set</StatusPill>
                            )}
                          </div>
                          <div className="stg-driver-detail">{row.detail}</div>
                          {DRIVER_DEFAULT_MODEL[row.id] && (
                            <div className="mono stg-driver-model">
                              Default model: {DRIVER_DEFAULT_MODEL[row.id]}
                            </div>
                          )}
                        </div>
                        {(() => {
                          // Block "Set primary" for API-key-backed drivers
                          // until a key is configured (either already stored
                          // in the secure store OR present as a draft in the
                          // input below). Without this guard the user can
                          // happily flip driver to e.g. OpenAI with no key,
                          // and the first recipe run later fails with a
                          // confusing "API key not configured" — far away
                          // from the action that caused it.
                          const needsKey = !!provider;
                          const draftKey = provider
                            ? keyDrafts[provider]?.trim()
                            : "";
                          const hasKey = keyPresent || !!draftKey;
                          const missingKey = needsKey && !hasKey;
                          const disabled =
                            isPrimary ||
                            driverSaving === row.id ||
                            missingKey;
                          return (
                            <button
                              type="button"
                              onClick={() => setPrimary(row.id)}
                              disabled={disabled}
                              title={
                                missingKey
                                  ? `Add ${provider} API key first.`
                                  : undefined
                              }
                              aria-label={`Set ${row.name} as primary driver`}
                              className="stg-action-btn"
                              data-disabled={String(disabled)}
                            >
                              {driverSaving === row.id ? "Saving…" : "Set primary"}
                            </button>
                          );
                        })()}
                      </div>
                      {provider && (
                        <div className="stg-key-row">
                          <input
                            id={`api-key-${provider}`}
                            type="password"
                            placeholder={keyPresent ? "Replace key…" : `${provider} API key`}
                            autoComplete="off"
                            value={keyDrafts[provider]}
                            onChange={(e) => setKeyDrafts((d) => ({ ...d, [provider]: e.target.value }))}
                            className="stg-input stg-input-key"
                          />
                          <button
                            type="button"
                            onClick={() => saveApiKey(provider)}
                            disabled={keySaving === provider || keyDrafts[provider].length === 0}
                            className="stg-action-btn"
                            aria-label={`Save ${provider} API key`}
                            data-disabled={String(keySaving === provider || keyDrafts[provider].length === 0)}
                          >
                            {keySaving === provider ? "Saving…" : "Save"}
                          </button>
                          {keyPresent && (
                            <button
                              type="button"
                              onClick={() => {
                                setKeyDrafts((d) => ({ ...d, [provider]: "" }));
                                // Empty string deletes from secure store.
                                // Pass "" explicitly — saveApiKey would
                                // otherwise read the stale closure key.
                                void saveApiKey(provider, "");
                              }}
                              disabled={keySaving === provider}
                              title="Remove the stored key from the secure store"
                              aria-label={`Clear ${provider} API key`}
                              className="stg-action-btn"
                              data-disabled={String(keySaving === provider)}
                            >
                              Clear
                            </button>
                          )}
                          {keyMsg && keyMsg.provider === provider && (
                            <span className="stg-msg" data-ok={String(keyMsg.ok)}>
                              {keyMsg.text}
                            </span>
                          )}
                        </div>
                      )}
                      {row.id === "local" && (
                        <div className="stg-local-fields">
                          <div className="stg-local-row">
                            <input
                              id="local-endpoint"
                              type="text"
                              placeholder="http://localhost:11434/v1 (Ollama default)"
                              value={localEndpoint}
                              onChange={(e) => {
                                localDirtyRef.current = true;
                                setLocalEndpoint(e.target.value);
                              }}
                              className="stg-input stg-input-local"
                              aria-label="Local LLM endpoint URL"
                            />
                          </div>
                          <div className="stg-local-row">
                            <input
                              id="local-model"
                              type="text"
                              placeholder="llama3.2 (or any model your runtime serves)"
                              value={localModel}
                              onChange={(e) => {
                                localDirtyRef.current = true;
                                setLocalModel(e.target.value);
                              }}
                              className="stg-input stg-input-local"
                              aria-label="Local LLM default model"
                            />
                            <button
                              type="button"
                              onClick={saveLocalConfig}
                              disabled={localSaving || !localEndpoint.trim()}
                              className="stg-action-btn"
                              aria-label="Save local LLM config"
                              data-disabled={String(localSaving || !localEndpoint.trim())}
                            >
                              {localSaving ? "Saving…" : "Save"}
                            </button>
                            {localMsg && (
                              <span className="stg-msg" data-ok={String(localMsg.ok)}>
                                {localMsg.text}
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                {driverMsg && (
                  <p className="stg-msg stg-msg-p" data-ok={String(driverMsg.ok)}>
                    {driverMsg.text}
                  </p>
                )}
                {restartPending && (
                  <div className="stg-restart-card">
                    <div className="stg-restart-header">
                      <div className="stg-restart-meta">
                        <div className="stg-restart-title">
                          Restart Required
                        </div>
                        <div className="stg-restart-desc">
                          The bridge needs to restart to apply the new driver configuration.
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={restartBridge}
                        disabled={restartBusy}
                        className="stg-restart-btn"
                        data-busy={String(restartBusy)}
                      >
                        {restartBusy ? "Restarting..." : "Restart Bridge"}
                      </button>
                    </div>
                    {restartMsg && (
                      <p className="stg-msg stg-msg-restart" data-ok={String(restartMsg.ok)}>
                        {restartMsg.text}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Approval policy */}
            <div id="s-approval" className="card">
              <div className="card-head">
                <div>
                  <h2 className="stg-card-h2">Approval policy</h2>
                  <div className="stg-card-subtitle">
                    Autopilot rules and Claude Code permission tiers.
                  </div>
                </div>
              </div>

              <div className="stg-section-padded">
                <label htmlFor="delegation-policy" className="stg-label">
                  Delegation policy
                </label>
                <p className="stg-help">
                  Hold high-risk or all tool calls for review before execution. Takes effect for new sessions
                  immediately.
                </p>
                <div className="stg-gate-row">
                  <select
                    id="delegation-policy"
                    value={gatePending}
                    disabled={gateSaving}
                    onChange={(e) => {
                      setGateSaveMsg(null);
                      {
                        const v = e.target.value as "off" | "high" | "all";
                        gatePendingRef.current = v;
                        setGatePending(v);
                      }
                    }}
                    className="stg-input stg-select"
                  >
                    <option value="off">off — no gating</option>
                    <option value="high">high — gate high-risk tools</option>
                    <option value="all">all — gate every tool call</option>
                  </select>
                  <button
                    type="button"
                    disabled={gateSaving || gatePending === gateValue}
                    onClick={() => saveGate(gatePending)}
                    className="stg-save-btn"
                    aria-label="Save delegation policy"
                    data-disabled={String(gateSaving || gatePending === gateValue)}
                  >
                    {gateSaving ? "Saving…" : "Save"}
                  </button>
                  {gateSaveMsg && (
                    <span className="stg-msg" data-ok={String(gateSaveMsg.ok)}>
                      {gateSaveMsg.text}
                    </span>
                  )}
                </div>
              </div>

              <div className="stg-section-padded">
                <label
                  htmlFor="time-of-day-anomaly"
                  className="stg-checkbox-label"
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
                <p className="stg-help stg-help-indent">
                  Surfaces a chip on approvals when a tool runs outside your usual hours.
                </p>
                {todayAnomalyErr && (
                  <p className="stg-help stg-help-indent stg-help-err">
                    {todayAnomalyErr}
                  </p>
                )}
              </div>

              <div className="stg-section-solo">
                <div className="stg-label">Claude Code permission rules</div>
                <p className="stg-help">
                  Mirrored from <code>~/.claude/settings.json</code>. Edit there to change.
                </p>
                {permRules ? (
                  <div className="stg-perm-grid">
                    <PermColumn tone="ok" title="Allow" rules={permRules.allow} />
                    <PermColumn tone="warn" title="Ask" rules={permRules.ask} />
                    <PermColumn tone="err" title="Deny" rules={permRules.deny} />
                  </div>
                ) : (
                  <p className="stg-help stg-help-mt">No permission data available.</p>
                )}
              </div>
            </div>

            {/* Safety — kill-switch (#422) */}
            <div
              id="s-safety"
              className="card"
              style={{
                borderColor: ksEngaged ? "var(--err)" : undefined,
                background: ksEngaged
                  ? "color-mix(in srgb, var(--err) 4%, var(--card-bg, var(--surface)))"
                  : undefined,
                transition: "border-color 0.3s ease, background 0.3s ease",
              }}
            >
              <div className="card-head">
                <div>
                  <h2 className="stg-card-h2" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span
                      aria-hidden="true"
                      style={{
                        fontSize: "var(--fs-base)",
                        opacity: ksEngaged ? 1 : 0.4,
                        transition: "opacity 0.3s ease",
                      }}
                    >
                      ⚠️
                    </span>
                    Safety
                  </h2>
                  <div className="stg-card-subtitle">
                    Write-tier kill switch for this bridge. When engaged, every
                    recipe step + connector tool tagged write-tier
                    refuses to run on the bridge this dashboard is connected
                    to. Use during an incident; release when safe. If you run
                    multiple bridges, each has its own kill switch — this
                    only affects the one this dashboard talks to.
                  </div>
                </div>
              </div>
              <div className="stg-section-solo">
                <ToggleRow
                  id="kill-switch-toggle"
                  label={
                    ksEngaged
                      ? "Kill switch — ENGAGED (writes blocked)"
                      : "Kill switch — released (writes allowed)"
                  }
                  help="Equivalent to running `patchwork kill-switch engage` / `release` from the CLI. Affects only the single bridge this dashboard is connected to — a bridge on another host keeps running normally."
                  checked={ksEngaged}
                  disabled={ksLocked || ksSaving}
                  disabledReason={
                    ksLocked
                      ? ksLockedReason ??
                        "Locked by PATCHWORK_FLAG_KILL_SWITCH_WRITES at bridge startup — restart with that env unset to toggle from here."
                      : undefined
                  }
                  onChange={(value) => setKsConfirmValue(value)}
                />
                {ksMsg && (
                  <p className="stg-msg stg-msg-p stg-msg-ks" data-ok={String(ksMsg.ok)}>
                    {ksMsg.text}
                  </p>
                )}
              </div>
            </div>

            <KillSwitchConfirmDialog
              open={ksConfirmValue !== null}
              onClose={() => setKsConfirmValue(null)}
              direction={ksConfirmValue ? "engage" : "release"}
              onConfirm={async () => {
                const value = ksConfirmValue;
                setKsConfirmValue(null);
                if (value === null) return;
                setKsSaving(true);
                setKsMsg(null);
                try {
                  const res = await fetch(apiPath("/api/bridge/kill-switch"), {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ engage: value }),
                  });
                  const j = (await res.json().catch(() => ({}))) as {
                    ok?: boolean;
                    engaged?: boolean;
                    changed?: boolean;
                    error?: string;
                    lockedReason?: string;
                  };
                  if (res.status === 409) {
                    setKsLocked(true);
                    setKsLockedReason(j.lockedReason);
                    setKsMsg({
                      ok: false,
                      text: `Env-locked: ${j.lockedReason ?? "policy override"}`,
                    });
                    return;
                  }
                  if (!res.ok) {
                    setKsMsg({
                      ok: false,
                      text: `Bridge returned ${res.status}: ${j.error ?? "unknown"}`,
                    });
                    return;
                  }
                  setKsEngaged(Boolean(j.engaged));
                  setKsMsg({
                    ok: true,
                    text: j.changed
                      ? `Kill switch ${value ? "engaged" : "released"}.`
                      : "Already in target state — no change.",
                  });
                } catch (err) {
                  setKsMsg({
                    ok: false,
                    text: `Failed to reach bridge: ${err instanceof Error ? err.message : String(err)}`,
                  });
                } finally {
                  setKsSaving(false);
                }
              }}
            />

            {/* Mobile — extracted to ./_components/MobileSection */}
            <MobileSection flashSaved={flashSaved} />

            {/* Telemetry — extracted to ./_components/TelemetrySection */}
            <TelemetrySection flashSaved={flashSaved} />
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Side nav for /settings. Extracted + React.memo'd because the parent
 * SettingsPage component is 2000+ lines with 60+ useState hooks — every
 * keystroke in any input re-renders the whole tree. Memoizing the nav
 * (which depends only on \`active\`) keeps it stable across unrelated
 * state changes.
 */
const SettingsNavList = memo(function SettingsNavList({
  active,
  onSelect,
}: {
  active: SectionId;
  onSelect: (id: SectionId) => void;
}) {
  return (
    <>
      {NAV.map(({ id, label }) => {
        const isActive = active === id;
        return (
          <a
            key={id}
            href={`#${id}`}
            onClick={() => onSelect(id)}
            className="stg-nav-link"
            data-active={String(isActive)}
          >
            {label}
          </a>
        );
      })}
    </>
  );
});

// ToggleRow, PermColumn, ConfigFileCard extracted to ./_components/
// as the first slice of the settings-page split.
