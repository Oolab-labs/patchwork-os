"use client";

import { Suspense, useEffect, useRef } from "react";
import { apiPath } from '@/lib/api';
import { useRouter, useSearchParams } from "next/navigation";

function GitLabCallbackInner() {
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

    fetch(apiPath(`/api/connections/gitlab/callback?${qs.toString()}`))
      .then((r) => r.json())
      .then(() => {
        if (window.opener) {
          window.opener.postMessage("patchwork:gitlab:connected", window.location.origin);
          window.close();
        } else {
          router.push("/connections");
        }
      })
      .catch(() => router.push("/connections"));
  }, [params, router]);

  return <p>Connecting GitLab…</p>;
}

export default function GitLabCallbackPage() {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      minHeight: "100vh", background: "#040406", color: "#e0e0e0",
      fontFamily: "system-ui, sans-serif",
    }}>
      <Suspense fallback={<p>Loading…</p>}>
        <GitLabCallbackInner />
      </Suspense>
    </div>
  );
}
