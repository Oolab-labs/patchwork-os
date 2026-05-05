"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { apiPath } from "@/lib/api";
import { useRouter, useSearchParams } from "next/navigation";

type Provider = {
  id: string;
  label: string;
};

function CallbackInner({ provider }: { provider: Provider }) {
  const params = useSearchParams();
  const router = useRouter();
  const called = useRef(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

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

    const fail = (msg: string) => {
      setErrorMsg(msg);
      if (window.opener) {
        try {
          window.opener.postMessage(
            `patchwork:${provider.id}:error:${msg}`,
            window.location.origin,
          );
        } catch {}
        setTimeout(() => window.close(), 1500);
      } else {
        setTimeout(
          () => router.push(`/connections?error=${encodeURIComponent(msg)}`),
          1500,
        );
      }
    };

    fetch(apiPath(`/api/connections/${provider.id}/callback?${qs.toString()}`))
      .then(async (r) => {
        let body: unknown = null;
        try {
          body = await r.json();
        } catch {}

        const ok =
          r.ok &&
          (body == null ||
            typeof body !== "object" ||
            (body as { ok?: unknown }).ok !== false);

        if (!ok) {
          const msg =
            (body && typeof body === "object" && "error" in body
              ? String((body as { error?: unknown }).error ?? "")
              : "") ||
            (error ? `oauth_${error}` : `http_${r.status}`);
          fail(msg);
          return;
        }

        if (window.opener) {
          window.opener.postMessage(
            `patchwork:${provider.id}:connected`,
            window.location.origin,
          );
          window.close();
        } else {
          router.push("/connections");
        }
      })
      .catch((err) => {
        fail(err instanceof Error ? err.message : "network_error");
      });
  }, [params, router, provider.id]);

  if (errorMsg) {
    return (
      <p role="alert" aria-live="assertive">
        {provider.label} connection failed: {errorMsg}
      </p>
    );
  }
  return (
    <p role="status" aria-live="polite">
      Connecting {provider.label}…
    </p>
  );
}

export function OAuthCallback({ provider }: { provider: Provider }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        background: "var(--canvas)",
        color: "var(--ink-0)",
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
        padding: "var(--s-4, 16px)",
        textAlign: "center",
      }}
    >
      <Suspense fallback={<p role="status">Loading…</p>}>
        <CallbackInner provider={provider} />
      </Suspense>
    </div>
  );
}
