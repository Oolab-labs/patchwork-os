/**
 * Push dispatcher — sends a notification to all devices for a given userId.
 * Abstracts over FCM (firebase-admin) and APNS (@parse/node-apn).
 *
 * Designed for fire-and-forget: caller does not need to await. Errors are
 * swallowed per-device so a bad APNS token doesn't block the FCM send.
 */

import type { DeviceRegistry } from "./deviceRegistry.js";

export interface PushPayload {
  callId: string;
  toolName: string;
  tier: string;
  summary?: string;
  requestedAt: number;
  expiresAt: number;
  approvalToken: string;
  bridgeCallbackBase: string;
}

export interface FcmAdapter {
  sendEach(messages: FcmMessage[]): Promise<{
    responses: Array<{ success: boolean; error?: { code: string } }>;
  }>;
}

export interface FcmMessage {
  token: string;
  notification: { title: string; body: string };
  data: Record<string, string>;
  android: { priority: "high" };
}

export interface ApnsAdapter {
  send(notification: ApnsNotification, tokens: string[]): Promise<ApnsResult>;
}

export interface ApnsNotification {
  alert: { title: string; body: string };
  payload: Record<string, unknown>;
  topic: string;
  priority: number;
  pushType: "alert";
}

export interface ApnsResult {
  failed: Array<{ device: string; error?: { reason: string } }>;
}

export interface DispatcherDeps {
  registry: DeviceRegistry;
  fcm?: FcmAdapter;
  apns?: ApnsAdapter;
  apnsTopic?: string;
}

function buildTitle(_toolName: string, tier: string): string {
  const urgency = tier === "high" ? "⚠️ " : "";
  return `${urgency}Approval required`;
}

function buildBody(toolName: string, summary?: string): string {
  return summary ?? `Tool: ${toolName}`;
}

export async function dispatchToUser(
  userId: string,
  payload: PushPayload,
  deps: DispatcherDeps,
): Promise<{ sent: number; failed: number }> {
  const devices = await deps.registry.list(userId);
  if (devices.length === 0) return { sent: 0, failed: 0 };

  const title = buildTitle(payload.toolName, payload.tier);
  const body = buildBody(payload.toolName, payload.summary);

  // Token is sent in the FCM/APNS data payload (out of the URL) so it does
  // not appear in HTTP access logs, browser history, or Referer headers.
  // The service worker pulls `approvalToken` from `data` and sends it as
  // an `x-approval-token` header on the approve/reject POST.
  const approveUrl = `${payload.bridgeCallbackBase}/approve/${payload.callId}`;
  const rejectUrl = `${payload.bridgeCallbackBase}/reject/${payload.callId}`;

  const fcmDevices = devices.filter((d) => d.platform === "fcm");
  const apnsDevices = devices.filter((d) => d.platform === "apns");

  let sent = 0;
  let failed = 0;

  // FCM batch send
  if (deps.fcm && fcmDevices.length > 0) {
    const messages: FcmMessage[] = fcmDevices.map((d) => ({
      token: d.token,
      notification: { title, body },
      data: {
        callId: payload.callId,
        toolName: payload.toolName,
        tier: payload.tier,
        approvalToken: payload.approvalToken,
        approveUrl,
        rejectUrl,
        expiresAt: String(payload.expiresAt),
      },
      android: { priority: "high" },
    }));

    try {
      const result = await deps.fcm.sendEach(messages);
      for (const r of result.responses) {
        if (r.success) sent++;
        else failed++;
      }
    } catch {
      failed += fcmDevices.length;
    }
  }

  // APNS per-device (node-apn batch API)
  if (deps.apns && apnsDevices.length > 0 && deps.apnsTopic) {
    const note: ApnsNotification = {
      alert: { title, body },
      payload: {
        callId: payload.callId,
        toolName: payload.toolName,
        tier: payload.tier,
        approvalToken: payload.approvalToken,
        approveUrl,
        rejectUrl,
        expiresAt: payload.expiresAt,
      },
      topic: deps.apnsTopic,
      priority: 10,
      pushType: "alert",
    };

    try {
      const result = await deps.apns.send(
        note,
        apnsDevices.map((d) => d.token),
      );
      failed += result.failed.length;
      sent += apnsDevices.length - result.failed.length;
    } catch {
      failed += apnsDevices.length;
    }
  }

  return { sent, failed };
}
