/**
 * post.ts — POST the flat payload to the tenant webhook.
 *
 *   X-Hub-Signature-256: sha256=<HMAC over RAW body>  (additive; QUMO_WEBHOOK_SECRET)
 *   Authorization: Bearer <token>                      (the real anti-spoof gate)
 *
 * 10s timeout, 2 retries with backoff. Degraded payloads still post. Skipped on
 * --dry-run (the engine just prints the payload). Secret + URL from env only,
 * never committed.
 */

import { createHmac } from "node:crypto";
import type { QumoPayload } from "./types.js";

export interface PostResult {
  ok: boolean;
  status?: number;
  attempts: number;
  error?: string;
  skipped?: boolean;
}

const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;

/** POST the payload. Returns a result object; never throws. */
export async function postPayload(payload: QumoPayload): Promise<PostResult> {
  const url = process.env.QUMO_WEBHOOK_URL;
  if (!url) {
    return {
      ok: false,
      attempts: 0,
      skipped: true,
      error: "QUMO_WEBHOOK_URL not set",
    };
  }
  const body = JSON.stringify(payload);
  const secret = process.env.QUMO_WEBHOOK_SECRET;
  const token = process.env.QUMO_BRIDGE_TOKEN;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (secret) {
    const sig = createHmac("sha256", secret)
      .update(body, "utf-8")
      .digest("hex");
    headers["X-Hub-Signature-256"] = `sha256=${sig}`;
  }

  let lastErr = "";
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.ok) return { ok: true, status: res.status, attempts: attempt };
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      clearTimeout(timer);
      lastErr = (err as Error).message ?? String(err);
    }
    if (attempt <= MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  return { ok: false, attempts: MAX_RETRIES + 1, error: lastErr };
}
