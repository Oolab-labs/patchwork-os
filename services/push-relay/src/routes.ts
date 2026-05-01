/**
 * Express routes for the push relay.
 *
 * POST /push             — bridge sends approval payload; relay dispatches push
 * POST /devices/register — PWA service worker registers device token
 * DELETE /devices/:token — deregister device
 * GET  /devices/count    — how many devices for this user (settings page)
 * POST /push/test        — send a synthetic test notification (settings page)
 *
 * All routes require bearer auth (see auth.ts). userId is attached to req
 * by the middleware.
 */

import { type Request, Router } from "express";
import type { DeviceRegistry } from "./deviceRegistry.js";
import {
  type DispatcherDeps,
  dispatchToUser,
  type PushPayload,
} from "./dispatcher.js";

type AuthedRequest = Request & { userId: string };

// Replay defense: refuse to re-dispatch the same (callId, approvalToken)
// pair. The bridge's own approvalQueue single-uses tokens, but a captured
// /push body re-POSTed against the relay would otherwise be silently
// re-fanned to devices. Window mirrors the longest tolerated approval
// expiry (15 min cap, see clamp below).
const REPLAY_WINDOW_MS = 15 * 60_000;
const REPLAY_MAX_ENTRIES = 10_000;

// expiresAt clamp: caller-supplied expiresAt is forwarded into the FCM/APNS
// data payload; a 10-year value would be honoured by phone clients indefinitely.
// Clamp to now+5min by default, hard-cap at now+15min.
const EXPIRY_DEFAULT_MS = 5 * 60_000;
const EXPIRY_CAP_MS = 15 * 60_000;

// Per-user rate limit for /devices/register. Without this an attacker with
// a leaked bearer token can flood until the per-user device cap (10) is
// reached, evicting the victim's real device on every cycle.
const REGISTER_LIMIT = 5;
const REGISTER_WINDOW_MS = 60_000;

export function buildRouter(
  registry: DeviceRegistry,
  dispatcherDeps: Omit<DispatcherDeps, "registry">,
): Router {
  const router = Router();
  const deps: DispatcherDeps = { registry, ...dispatcherDeps };

  // Per-router-instance state. Module-scoped state would leak across tests
  // and across multi-tenant relay instances if anyone ever runs more than
  // one router on the same process.
  const replaySeen = new Map<string, number>(); // (callId:approvalToken) → expiresAt ms
  const registerCounts = new Map<string, { count: number; resetAt: number }>();

  function pruneReplay(now: number): void {
    if (replaySeen.size < REPLAY_MAX_ENTRIES) return;
    for (const [key, expiry] of replaySeen) {
      if (expiry < now) replaySeen.delete(key);
    }
  }

  // POST /push — called by bridge after queuing an approval
  router.post("/push", async (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const body = req.body as Partial<PushPayload>;

    if (!body.callId || !body.toolName || !body.tier || !body.approvalToken) {
      res.status(400).json({
        error: "missing required fields: callId, toolName, tier, approvalToken",
      });
      return;
    }

    const now = Date.now();

    // Reject already-expired payloads. Caller may have queued slowly or be
    // replaying a stale capture.
    if (typeof body.expiresAt === "number" && body.expiresAt < now) {
      res.status(400).json({ error: "payload already expired" });
      return;
    }

    // Replay defense — single-use per (callId, approvalToken) within window.
    const replayKey = `${body.callId}:${body.approvalToken}`;
    const seenExpiry = replaySeen.get(replayKey);
    if (seenExpiry !== undefined && seenExpiry > now) {
      res.status(409).json({ error: "duplicate push within replay window" });
      return;
    }
    pruneReplay(now);
    replaySeen.set(replayKey, now + REPLAY_WINDOW_MS);

    // Clamp expiresAt: default to +5min, hard-cap at +15min.
    let expiresAt = body.expiresAt ?? now + EXPIRY_DEFAULT_MS;
    if (expiresAt > now + EXPIRY_CAP_MS) {
      expiresAt = now + EXPIRY_DEFAULT_MS;
    }

    const payload: PushPayload = {
      callId: body.callId,
      toolName: body.toolName,
      tier: body.tier,
      summary: body.summary,
      requestedAt: body.requestedAt ?? now,
      expiresAt,
      approvalToken: body.approvalToken,
      bridgeCallbackBase: body.bridgeCallbackBase ?? "",
    };

    // Fire-and-forget — never block the bridge's approval flow
    dispatchToUser(userId, payload, deps).catch(() => {});

    res.json({ ok: true });
  });

  // POST /devices/register
  router.post("/devices/register", async (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const { token, platform } = req.body as {
      token?: string;
      platform?: string;
    };

    if (!token || (platform !== "fcm" && platform !== "apns")) {
      res.status(400).json({ error: "token and platform (fcm|apns) required" });
      return;
    }

    // Per-user rate limit: blocks bearer-token leak abuse from churning
    // device registrations and evicting the legitimate user's device.
    const now = Date.now();
    const slot = registerCounts.get(userId);
    if (!slot || slot.resetAt < now) {
      registerCounts.set(userId, {
        count: 1,
        resetAt: now + REGISTER_WINDOW_MS,
      });
    } else {
      slot.count += 1;
      if (slot.count > REGISTER_LIMIT) {
        res.status(429).json({
          error: `too many registrations; max ${REGISTER_LIMIT} per minute`,
        });
        return;
      }
    }

    await registry.register(userId, {
      token,
      platform,
      registeredAt: now,
    });
    res.json({ ok: true });
  });

  // DELETE /devices — preferred form; FCM tokens contain "/" and ":" which
  // break path-param matching. Token in JSON body avoids any URL-encoding
  // ambiguity.
  router.delete("/devices", async (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const token = (req.body as { token?: string }).token;
    if (!token) {
      res.status(400).json({ error: "token required in body" });
      return;
    }
    await registry.remove(userId, token);
    res.json({ ok: true });
  });

  // DELETE /devices/:token — legacy form, kept for back-compat. Tokens with
  // "/" or ":" must use the body form above.
  router.delete("/devices/:token", async (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const token = decodeURIComponent(req.params.token as string);
    await registry.remove(userId, token);
    res.json({ ok: true });
  });

  // GET /devices/count — for dashboard settings card
  router.get("/devices/count", async (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const count = await registry.count(userId);
    res.json({ count });
  });

  // POST /push/test — synthetic notification (no callId required)
  router.post("/push/test", async (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const testPayload: PushPayload = {
      callId: `test-${Date.now()}`,
      toolName: "testNotification",
      tier: "low",
      summary: "Test notification from Patchwork dashboard",
      requestedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      approvalToken: "test-token",
      bridgeCallbackBase: "",
    };
    const result = await dispatchToUser(userId, testPayload, deps);
    res.json(result);
  });

  return router;
}
