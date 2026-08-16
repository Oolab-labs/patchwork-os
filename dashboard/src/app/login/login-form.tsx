"use client";
import { useState } from "react";
import { apiPath } from "@/lib/api";

/**
 * Single-password login form. Posts to /api/login, follows the JSON
 * `redirect` field on success. Same-origin POST so the SameSite=Strict
 * cookie that comes back is set.
 */
export function LoginForm({
  next,
  members = false,
}: {
  next: string;
  /** True when at least one member has a credential on file (ADR-0020). */
  members?: boolean;
}) {
  const [pw, setPw] = useState("");
  const [memberId, setMemberId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!pw) return;
    setBusy(true);
    setErr("");
    try {
      // Audit 2026-05-17 (#600): use apiPath() so the form works when
      // NEXT_PUBLIC_BASE_PATH is anything other than the literal
      // "/dashboard" (root mount, custom prefix, etc.). The hardcoded
      // path 404'd on non-default deploys and showed a generic "Error
      // 404" to the user with no hint why.
      const res = await fetch(apiPath("/api/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `memberId` is sent ONLY when the operator typed one. An empty
        // string would make every login member-shaped, and the route answers
        // a member-shaped request from the identity seam alone — so the
        // shared password would stop working entirely.
        body: JSON.stringify({
          password: pw,
          next,
          ...(memberId.trim() ? { memberId: memberId.trim() } : {}),
        }),
      });
      if (res.ok) {
        const body = (await res.json()) as { redirect?: string };
        // Use replace so the back button doesn't return to /login.
        window.location.replace(body.redirect ?? "/dashboard");
        return;
      }
      if (res.status === 429) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setErr(body.error ?? "too many attempts — wait a minute");
      } else if (res.status === 401) {
        setErr(memberId.trim() ? "Invalid credentials." : "Invalid password.");
      } else if (res.status === 503) {
        // Two different 503s: auth unconfigured, or a member id that cannot
        // be attributed. The server's message distinguishes them; a generic
        // string here would send the operator to check env vars over a
        // problem in members.json.
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setErr(body.error ?? "Dashboard auth not configured server-side.");
      } else {
        setErr(`Error ${res.status}`);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 320 }}>
      {members && (
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: "var(--fs-m)", color: "var(--ink-1)" }}>
          Member id <span style={{ color: "var(--ink-2)" }}>(optional)</span>
          <input
            type="text"
            autoComplete="username"
            placeholder="leave blank for the shared password"
            value={memberId}
            onChange={(e) => setMemberId(e.target.value)}
            disabled={busy}
            style={{
              background: "var(--recess)",
              border: "1px solid var(--line-2)",
              borderRadius: "var(--r-2)",
              color: "var(--ink-0)",
              fontSize: "var(--fs-m)",
              fontFamily: "var(--font-mono)",
              padding: "8px 10px",
            }}
          />
        </label>
      )}
      <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: "var(--fs-m)", color: "var(--ink-1)" }}>
        {members ? "Password" : "Dashboard password"}
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          disabled={busy}
          style={{
            background: "var(--recess)",
            border: "1px solid var(--line-2)",
            borderRadius: "var(--r-2)",
            color: "var(--ink-0)",
            fontSize: "var(--fs-m)",
            fontFamily: "var(--font-mono)",
            padding: "8px 10px",
          }}
        />
      </label>
      <button
        type="submit"
        disabled={busy || !pw}
        style={{
          fontSize: "var(--fs-base)",
          fontWeight: 600,
          padding: "10px 14px",
          borderRadius: "var(--r-2)",
          border: "none",
          background: "var(--accent)",
          color: "var(--on-orange)",
          cursor: busy || !pw ? "default" : "pointer",
          opacity: busy || !pw ? 0.5 : 1,
        }}
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>
      {err && (
        <p role="alert" aria-live="polite" style={{ margin: 0, fontSize: "var(--fs-s)", color: "var(--err)" }}>{err}</p>
      )}
    </form>
  );
}
