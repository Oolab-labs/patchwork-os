"use client";
import { useState } from "react";

/**
 * Single-password login form. Posts to /api/login, follows the JSON
 * `redirect` field on success. Same-origin POST so the SameSite=Strict
 * cookie that comes back is set.
 */
export function LoginForm({ next }: { next: string }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!pw) return;
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/dashboard/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw, next }),
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
        setErr("Invalid password.");
      } else if (res.status === 503) {
        setErr("Dashboard auth not configured server-side.");
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
      <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: "var(--fs-m)", color: "var(--ink-1)" }}>
        Dashboard password
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
          fontSize: "var(--fs-s)",
          fontWeight: 600,
          padding: "8px 14px",
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
        <p style={{ margin: 0, fontSize: "var(--fs-s)", color: "var(--err)" }}>{err}</p>
      )}
    </form>
  );
}
