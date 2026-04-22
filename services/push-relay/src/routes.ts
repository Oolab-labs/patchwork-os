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

export function buildRouter(
  registry: DeviceRegistry,
  dispatcherDeps: Omit<DispatcherDeps, "registry">,
): Router {
  const router = Router();
  const deps: DispatcherDeps = { registry, ...dispatcherDeps };

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

    const payload: PushPayload = {
      callId: body.callId,
      toolName: body.toolName,
      tier: body.tier,
      summary: body.summary,
      requestedAt: body.requestedAt ?? Date.now(),
      expiresAt: body.expiresAt ?? Date.now() + 5 * 60_000,
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

    await registry.register(userId, {
      token,
      platform,
      registeredAt: Date.now(),
    });
    res.json({ ok: true });
  });

  // DELETE /devices/:token
  router.delete("/devices/:token", async (req, res) => {
    const userId = (req as AuthedRequest).userId;
    await registry.remove(userId, req.params.token as string);
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
