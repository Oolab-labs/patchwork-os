/**
 * Per-user bearer token auth for the relay service.
 *
 * Tokens are issued at Pro signup and stored as a map { token → userId }.
 * For MVP we support a single RELAY_AUTH_TOKEN env var mapped to a single
 * RELAY_USER_ID (self-hosted). Multi-tenant token management (DB-backed) is
 * a Pro hosted dashboard concern.
 */

import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export interface TokenStore {
  /** Returns userId for token, or null if not found. */
  lookup(token: string): string | null;
}

export class EnvTokenStore implements TokenStore {
  private readonly tokens: Map<string, string>;

  constructor(envTokens: string) {
    // Format: "token1:userId1,token2:userId2"
    this.tokens = new Map(
      envTokens
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.includes(":"))
        .map((s) => {
          const idx = s.indexOf(":");
          return [s.slice(0, idx), s.slice(idx + 1)] as [string, string];
        }),
    );
  }

  lookup(token: string): string | null {
    for (const [stored, userId] of this.tokens) {
      if (stored.length !== token.length) continue;
      try {
        if (timingSafeEqual(Buffer.from(stored), Buffer.from(token))) {
          return userId;
        }
      } catch {
        // length mismatch already guarded above — shouldn't happen
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
