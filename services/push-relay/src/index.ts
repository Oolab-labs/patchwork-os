/**
 * Patchwork Push Relay Service
 *
 * Environment variables:
 *   PORT                  — HTTP port (default 3001)
 *   RELAY_AUTH_TOKENS     — "token1:userId1,token2:userId2" (required)
 *   REDIS_URL             — Redis connection URL (optional; in-memory if absent)
 *   FCM_SERVICE_ACCOUNT   — JSON string of Firebase service account (optional)
 *   APNS_KEY              — APNS private key PEM (optional)
 *   APNS_KEY_ID           — APNS key ID (optional)
 *   APNS_TEAM_ID          — APNS team ID (optional)
 *   APNS_TOPIC            — APNS bundle ID / topic (optional)
 *   APNS_PRODUCTION       — "true" for production APNS gateway (default false)
 */

import express from "express";
import { bearerAuthMiddleware, EnvTokenStore } from "./auth.js";
import { InMemoryRegistry, RedisRegistry } from "./deviceRegistry.js";
import type { ApnsAdapter, FcmAdapter } from "./dispatcher.js";
import { buildRouter } from "./routes.js";

async function main() {
  const port = parseInt(process.env.PORT ?? "3001", 10);
  const authTokens = process.env.RELAY_AUTH_TOKENS ?? "";

  if (!authTokens) {
    console.error(
      "RELAY_AUTH_TOKENS env var required (format: token:userId,...)",
    );
    process.exit(1);
  }

  // Device registry
  let registry: InMemoryRegistry | RedisRegistry;
  if (process.env.REDIS_URL) {
    const { createClient } = await import("redis");
    const client = createClient({ url: process.env.REDIS_URL });
    await client.connect();
    console.log("Connected to Redis:", process.env.REDIS_URL);
    registry = new RedisRegistry(
      client as Parameters<typeof RedisRegistry>[0] extends { hSet: unknown }
        ? typeof client
        : never,
    );
  } else {
    console.log("No REDIS_URL — using in-memory device registry");
    registry = new InMemoryRegistry();
  }

  // FCM adapter
  let fcm: FcmAdapter | undefined;
  if (process.env.FCM_SERVICE_ACCOUNT) {
    const { default: admin } = await import("firebase-admin");
    let serviceAccount: unknown;
    try {
      serviceAccount = JSON.parse(process.env.FCM_SERVICE_ACCOUNT);
    } catch (err) {
      console.error(
        "FCM_SERVICE_ACCOUNT is not valid JSON — skipping FCM init:",
        err instanceof Error ? err.message : String(err),
      );
      serviceAccount = null;
    }
    if (serviceAccount && !admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    }
    fcm = admin.messaging() as unknown as FcmAdapter;
    console.log("FCM initialized");
  }

  // APNS adapter
  let apns: ApnsAdapter | undefined;
  let apnsTopic: string | undefined;
  if (
    process.env.APNS_KEY &&
    process.env.APNS_KEY_ID &&
    process.env.APNS_TEAM_ID
  ) {
    const apnModule = await import("@parse/node-apn");
    const provider = new apnModule.default.Provider({
      token: {
        key: process.env.APNS_KEY,
        keyId: process.env.APNS_KEY_ID,
        teamId: process.env.APNS_TEAM_ID,
      },
      production: process.env.APNS_PRODUCTION === "true",
    });
    apns = {
      send: async (notification, tokens) => {
        const note = new apnModule.default.Notification();
        note.alert = notification.alert;
        note.payload = notification.payload;
        note.topic = notification.topic;
        note.priority = notification.priority;
        note.pushType = notification.pushType;
        return provider.send(note, tokens);
      },
    };
    apnsTopic = process.env.APNS_TOPIC;
    console.log(
      "APNS initialized (production:",
      process.env.APNS_PRODUCTION === "true",
      ")",
    );
  }

  const tokenStore = new EnvTokenStore(authTokens);
  const app = express();
  app.use(express.json());
  app.use(bearerAuthMiddleware(tokenStore));
  app.use(buildRouter(registry, { fcm, apns, apnsTopic }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, fcm: !!fcm, apns: !!apns });
  });

  app.listen(port, () => {
    console.log(`Patchwork push relay listening on :${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
