"use client";

import { useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function GmailCallbackPage() {
  const params = useSearchParams();
  const router = useRouter();
  const called = useRef(false);

  useEffect(() => {
    if (called.current) return;
    called.current = true;

    const code = params.get("code");
    const state = params.get("state");
    const error = params.get("error");

    const qs = new URLSearchParams();
    if (code) qs.set("code", code);
    if (state) qs.set("state", state);
    if (error) qs.set("error", error);

    fetch(`/api/connections/gmail/callback?${qs.toString()}`)
      .then((r) => r.json())
      .then((data: { ok?: boolean; error?: string }) => {
        if (window.opener) {
          window.opener.postMessage("patchwork:gmail:connected", window.location.origin);
          window.close();
        } else {
          router.push("/connections");
        }
      })
      .catch(() => router.push("/connections"));
  }, [params, router]);

  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      minHeight: "100vh", background: "#040406", color: "#e0e0e0",
      fontFamily: "system-ui, sans-serif",
    }}>
      <p>Connecting Gmail…</p>
    </div>
  );
}
