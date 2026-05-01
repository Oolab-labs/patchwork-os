/**
 * Per-user bearer token auth for the relay service.
 *
 * Tokens are issued at Pro signup and stored as a map { token → userId }.
 * For MVP we support a single RELAY_AUTH_TOKEN env var mapped to a single
 * RELAY_USER_ID (self-hosted). Multi-tenant token management (DB-backed) is
 * a Pro hosted dashboard concern.
 *
 * Tokens are NEVER stored plaintext at rest. At construction we generate a
 * per-process HMAC key (32 random bytes) and store HMAC-SHA256(key, token)
 * keyed by base64. On lookup we hash the inbound token with the same key
 * and `timingSafeEqual` the digests. This means a heap dump leaks digests,
 * not credentials.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export interface TokenStore {
  /** Returns userId for token, or null if not found. */
  lookup(token: string): string | null;
}

export class EnvTokenStore implements TokenStore {
  // Per-process HMAC key. Random per startup, in-memory only — never written
  // to disk or env. Used to derive at-rest digests for stored tokens.
  private readonly hmacKey: Buffer;
  // Map<digest-base64, userId>. Keys are HMAC-SHA256 outputs, never plaintext.
  private readonly tokens: Map<string, string>;

  constructor(envTokens: string) {
    this.hmacKey = randomBytes(32);
    this.tokens = new Map();
    // Format: "token1:userId1,token2:userId2"
    for (const raw of envTokens.split(",")) {
      const s = raw.trim();
      if (!s.includes(":")) continue;
      const idx = s.indexOf(":");
      const token = s.slice(0, idx);
      const userId = s.slice(idx + 1);
      if (!token || !userId) continue;
      this.tokens.set(this.digest(token), userId);
    }
  }

  private digest(token: string): string {
    return createHmac("sha256", this.hmacKey)
      .update(token, "utf8")
      .digest("base64");
  }

  lookup(token: string): string | null {
    if (!token) return null;
    const candidate = this.digest(token);
    const candBuf = Buffer.from(candidate, "base64");
    for (const [stored, userId] of this.tokens) {
      const storedBuf = Buffer.from(stored, "base64");
      if (storedBuf.length !== candBuf.length) continue;
      if (timingSafeEqual(storedBuf, candBuf)) {
        return userId;
      }
    }
    return null;
  }
}

export function bearerAuthMiddleware(store: TokenStore) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ")) {
      res.status(401).json({ error: "missing bearer token" });
      return;
    }
    const token = auth.slice(7);
    const userId = store.lookup(token);
    if (!userId) {
      res.status(401).json({ error: "invalid token" });
      return;
    }
    (req as Request & { userId: string }).userId = userId;
    next();
  };
}
