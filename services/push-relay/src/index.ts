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
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { bearerAuthMiddleware, EnvTokenStore } from "./auth.js";
import { InMemoryRegistry, RedisRegistry } from "./deviceRegistry.js";
import type { ApnsAdapter, FcmAdapter } from "./dispatcher.js";
import { logErrorSafe } from "./redact.js";
import { buildRouter } from "./routes.js";

async function main() {
  const port = parseInt(process.env.PORT ?? "3001", 10);
  const authTokens = process.env.RELAY_AUTH_TOKENS ?? "";

  if (!authTokens) {
    logErrorSafe(
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
    // The redis v4 client structurally satisfies what RedisRegistry needs
    // (hSet/hDel/hGetAll/hLen) but its types are wider — `hDel` accepts a
    // RedisCommandArgument array plus an optional CommandOptions arg, which
    // doesn't match RedisRegistry's narrower `(key, ...fields)` signature.
    // Cast through `unknown` is justified: the runtime contract holds, only
    // the static signature is wider.
    registry = new RedisRegistry(
      client as unknown as ConstructorParameters<typeof RedisRegistry>[0],
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
      logErrorSafe(
        "FCM_SERVICE_ACCOUNT is not valid JSON — skipping FCM init:",
        err instanceof Error ? err.message : String(err),
      );
      serviceAccount = null;
    }
    // Don't keep the JSON service account string in process.env after we've
    // parsed it — child processes / `process.env` dumps would otherwise carry
    // the credential.
    delete process.env.FCM_SERVICE_ACCOUNT;
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
        const result = await provider.send(note, tokens);
        // node-apn returns ResponseFailure with `error: Error` (transport
        // failure) and `response: { reason: string }` (APNS-side rejection
        // like BadDeviceToken/Unregistered). Our ApnsResult contract carries
        // the APNS reason code, not the Error message — those are different
        // dispatch keys. Forward `response.reason` only.
        return {
          failed: result.failed.map((f) => ({
            device: f.device,
            error: f.response ? { reason: f.response.reason } : undefined,
          })),
        };
      },
    };
    apnsTopic = process.env.APNS_TOPIC;
    console.log(
      "APNS initialized (production:",
      process.env.APNS_PRODUCTION === "true",
      ")",
    );
    // Don't keep the PEM in process.env — the apn provider has captured it.
    delete process.env.APNS_KEY;
  }

  const tokenStore = new EnvTokenStore(authTokens);
  const app = express();
  // Behind a reverse proxy (Cloud Run, nginx, ELB) so X-Forwarded-For is
  // honoured by express-rate-limit for correct per-IP buckets.
  app.set("trust proxy", 1);
  app.use(helmet());
  // Push payloads are tiny (callId + approvalToken + a few flags); cap the
  // body to 16kb to shed memory-amplification attacks early.
  app.use(express.json({ limit: "16kb" }));

  // /health is mounted BEFORE the bearer middleware so uptime checkers
  // (Cloud Run, k8s liveness probes, ELB target groups) can hit it without
  // a token. The body is intentionally minimal — just `{ok:true}` — to
  // avoid leaking deployment shape (which providers are configured) to
  // unauthenticated callers.
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Global per-IP rate limit on authenticated endpoints. Sits AFTER the
  // /health exception so uptime probes are never throttled. Defence-in-depth
  // on top of the per-user registration limiter in routes.ts.
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 60,
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => req.path === "/health",
    }),
  );

  app.use(bearerAuthMiddleware(tokenStore));
  app.use(buildRouter(registry, { fcm, apns, apnsTopic }));

  // Authenticated extended-status endpoint for the dashboard / settings page
  // when it wants to know which adapters are live.
  app.get("/status", (_req, res) => {
    res.json({ ok: true, fcm: !!fcm, apns: !!apns });
  });

  // JSON error middleware — must follow all route registrations. Express's
  // default error handler renders an HTML page containing the stack trace and
  // absolute filesystem paths (e.g. node_modules/raw-body/index.js:163:17),
  // which leaks deployment shape on otherwise-correct error responses (e.g.
  // 413 from express.json's body cap). Force a minimal JSON envelope instead.
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const e = err as { statusCode?: unknown; type?: unknown };
      const status = typeof e?.statusCode === "number" ? e.statusCode : 500;
      const type = typeof e?.type === "string" ? e.type : "error";
      res.status(status).json({ error: type });
    },
  );

  // Server-to-server API: no browser callers, so CORS is intentionally
  // omitted (no Access-Control-Allow-Origin headers emitted). Helmet's
  // Cross-Origin-Resource-Policy: same-origin default reinforces this.

  const server = app.listen(port, () => {
    console.log(`Patchwork push relay listening on :${port}`);
  });
  // Bound request/header timeouts so a slow-client connection can't pin a
  // worker. headersTimeout must exceed requestTimeout per Node docs.
  server.requestTimeout = 10_000;
  server.headersTimeout = 11_000;
}

main().catch((err) => {
  logErrorSafe(err);
  process.exit(1);
});
