/**
 * Recipe + run-audit route dispatcher — extracted from src/server.ts.
 *
 * Owns 16 routes covering the recipe authoring loop (CRUD + lint + run),
 * the run-audit log (`/runs`, `/runs/:seq`, replay, plan), the public
 * template registry (`/templates`), and recipe installation
 * (`/recipes/install`). Plus the `/activation-metrics` siblings that
 * read the same audit log.
 *
 * DI shape: handlers depend on 12 nullable callbacks the bridge wires
 * onto the Server instance post-construction (`runRecipeFn`,
 * `recipesFn`, etc.). They're passed as a `RecipeRouteDeps` struct
 * matching the pattern from oauthRoutes.ts and mcpRoutes.ts.
 *
 * Module-level state: the `/templates` 5-minute cache used to live as
 * `_templatesCache`/`_templatesCacheTs` instance fields on Server.
 * Lifetime is process-wide either way (Server is a singleton in
 * practice), so hoisting to module scope here is equivalent and avoids
 * threading a mutable holder through `deps`.
 *
 * Mechanical lift: handler bodies are byte-identical save for
 * `deps.<fn>` replacing `this.<fn>` and module-scoped cache vars
 * replacing `this._templatesCache`. A few routes that previously used
 * `await` directly in their async parent closure are wrapped in
 * `void (async () => {...})()` so this module can return boolean
 * synchronously — same micro-task tradeoff documented in
 * connectorRoutes.ts.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  computeSummary as computeActivationSummary,
  loadMetrics as loadActivationMetrics,
} from "./activationMetrics.js";
import {
  consumeToken,
  refillBucket,
  type TokenBucketState,
} from "./fp/tokenBucket.js";
import { respond500 } from "./httpErrorResponse.js";
import type { RecipeDraft } from "./recipesHttp.js";
import { validateSafeUrl } from "./ssrfGuard.js";

// 5-minute cache of the public template registry from the patchworkos/recipes
// GitHub repo. Process-wide; hoisted out of Server class state.
let templatesCache: unknown = null;
let templatesCacheTs = 0;

/**
 * #605: shape-validate the upstream templates payload before caching.
 * The minimal contract used by the dashboard marketplace is `{recipes:
 * Array}` (other fields are optional). Anything else (an error page
 * JSON, a tampered file with a flipped key, a future GitHub schema
 * change) is rejected so we don't serve garbage for 5 minutes to every
 * dashboard client.
 */
function isWellFormedTemplatesPayload(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    // Some legacy callers used a bare array; accept that too.
    return Array.isArray(raw);
  }
  const r = raw as { recipes?: unknown };
  return Array.isArray(r.recipes);
}

/**
 * Per-process token bucket guarding `/recipes/generate`. Every call to the
 * route enqueues a Claude subprocess via the orchestrator — without a cap a
 * scripted attacker holding a bridge token can DoS the queue or run up
 * subscription costs. The bridge's existing `--tool-rate-limit` token bucket
 * is per-session and gates MCP tool calls, not HTTP routes; this is a
 * separate, route-scoped cap.
 *
 * Default: 10 req/min — generous for a feature that takes 5–10s per call.
 * Process-wide because the bridge HTTP transport doesn't expose a stable
 * per-caller identity beyond "valid bearer token", and the Claude
 * subprocess queue is the actual bottleneck regardless of caller.
 *
 * Exported `_resetGenerateRateLimitForTests` lets tests start each case
 * with a full bucket.
 */
const RECIPE_GENERATE_LIMIT_PER_MIN = 10;
let recipeGenerateBucket: TokenBucketState = {
  tokens: RECIPE_GENERATE_LIMIT_PER_MIN,
  lastRefill: 0,
};
export function _resetGenerateRateLimitForTests(): void {
  recipeGenerateBucket = {
    tokens: RECIPE_GENERATE_LIMIT_PER_MIN,
    lastRefill: 0,
  };
}

// G-security R2 C-3 / I-3 / F-02: HTTP `vars` validation.
//
// The post-render path jail in `src/recipes/resolveRecipePath.ts` is the
// actual defense against template-driven traversal — but rejecting bad
// vars at the HTTP layer is cheaper and gives the caller a precise 400
// instead of a generic 500 from the runner. Validation rules:
//
//   - keys      — `/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/`     (identifier-ish, ≤64)
//   - values    — `/^[\w\-. :+@,]+$/u`                  (no `/`, no `..`, no
//                                                        `~`, no control chars)
//   - type      — strings only; numbers/objects/arrays → 400 (type-strict
//                 per R3 amendment 4 / I-3, prevents JSON.stringify smuggling
//                 a `..` segment into a coerced value at render time).
const VARS_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const VARS_VALUE_RE = /^[\w\-. :+@,]+$/u;

export interface VarsValidationError {
  ok: false;
  error: string;
  field: "key" | "value" | "type";
  offendingKey?: string;
}

/** Validate the HTTP-supplied `vars` object. Returns null on success. */
export function validateRecipeVars(vars: unknown): VarsValidationError | null {
  if (vars == null) return null;
  if (typeof vars !== "object" || Array.isArray(vars)) {
    return {
      ok: false,
      error: "vars must be a plain object of string→string entries",
      field: "type",
    };
  }
  for (const [key, value] of Object.entries(vars as Record<string, unknown>)) {
    if (!VARS_KEY_RE.test(key)) {
      return {
        ok: false,
        error: `vars key "${key}" must match /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/`,
        field: "key",
        offendingKey: key,
      };
    }
    if (typeof value !== "string") {
      return {
        ok: false,
        error: `vars["${key}"] must be a string (got ${Array.isArray(value) ? "array" : typeof value})`,
        field: "type",
        offendingKey: key,
      };
    }
    if (value.length === 0 || value.length > 1024) {
      return {
        ok: false,
        error: `vars["${key}"] must be a non-empty string ≤ 1024 chars`,
        field: "value",
        offendingKey: key,
      };
    }
    if (!VARS_VALUE_RE.test(value)) {
      return {
        ok: false,
        error: `vars["${key}"] contains disallowed characters (no "/", "..", "~", or control chars)`,
        field: "value",
        offendingKey: key,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// BEGIN A-PR2 EDIT BLOCK — body-cap helpers (dogfood R2 M-1 / F-08)
//
// Per-route caps; install is the strictest because the request only carries
// a single `source` field. See PR description for sizing rationale.
// Coordination note: A-PR1 also touches `recipeRoutes.ts` for `vars`
// validation; the helper APIs here are exclusively A-PR2's.
// ---------------------------------------------------------------------
export const RECIPE_ROUTE_BODY_CAPS = {
  /** /recipes/install — `{ source: string }` body. */
  install: 4 * 1024,
  /** /recipes/generate — NL prompt. */
  generate: 4 * 1024,
  /** /recipes/:name/run + /recipes/run — vars envelope. */
  run: 32 * 1024,
  /** /recipes (POST), PUT/PATCH /recipes/:name, /recipes/lint — yaml content. */
  content: 256 * 1024,
} as const;

/**
 * Read an HTTP request body up to `max` bytes. Returns the raw string or
 * a `too_large` code. Used directly by routes whose handlers parse the
 * body themselves (e.g. connector token-paste handlers); also used as
 * the byte-collection layer for `readJsonBody`.
 *
 * Bytes are accumulated into a single Buffer so the helper can enforce
 * the cap incrementally — a 1 GB upload is rejected after the first
 * overflowing chunk rather than after the full body lands in memory.
 * On overflow the stream is drained (not destroyed) so the route can
 * write 413 cleanly.
 */
export function readBodyWithCap(
  req: IncomingMessage,
  max: number,
): Promise<
  { ok: true; body: string; bytes: Buffer } | { ok: false; code: "too_large" }
> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;

    const onData = (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.byteLength;
      if (total > max) {
        aborted = true;
        // Resolve immediately so the route can write 413; do NOT destroy the
        // socket here — destroying mid-upload races with the response write
        // and the client sees EPIPE/ECONNRESET before reading the body.
        // Subsequent chunks land in `onData` again but the `aborted` guard
        // discards them, draining the upload until the client emits `end`.
        resolve({ ok: false, code: "too_large" });
        // Force the underlying stream to keep flowing so buffered upload
        // data drains naturally. Without this Node may pause the stream
        // when nothing is consuming chunks, leaving the socket half-open.
        try {
          req.resume();
        } catch {
          // best-effort
        }
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      if (aborted) return;
      const bytes = Buffer.concat(chunks);
      // `bytes` is the raw on-the-wire body; `body` is the utf-8 decode used
      // by JSON parsers. HMAC consumers must use `bytes` to avoid the
      // utf-8 round-trip changing the signed payload.
      resolve({ ok: true, body: bytes.toString("utf-8"), bytes });
    };

    const onError = () => {
      if (aborted) return;
      aborted = true;
      // Treat aborted/error mid-stream as a malformed read. Callers that
      // care about the distinction can check the `code` on the
      // readJsonBody result; here we collapse to "too_large" to keep
      // the type narrow — in practice the network-error path is rare
      // and either response is 4xx.
      resolve({ ok: false, code: "too_large" });
    };

    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
  });
}

/**
 * Read an HTTP request body up to `max` bytes, parse as JSON, return result.
 *
 * Returns one of three discriminated shapes:
 *   - `{ ok: true, value }` — body parsed successfully.
 *   - `{ ok: false, code: "too_large" }` — body exceeded `max`; request was
 *     destroyed eagerly and the response should be 413.
 *   - `{ ok: false, code: "invalid_json" }` — body was valid bytes but failed
 *     `JSON.parse`; response should be 400.
 */
export async function readJsonBody<T = unknown>(
  req: IncomingMessage,
  max: number,
): Promise<
  { ok: true; value: T } | { ok: false; code: "too_large" | "invalid_json" }
> {
  const read = await readBodyWithCap(req, max);
  if (!read.ok) return { ok: false, code: "too_large" };
  if (read.body.length === 0) {
    // Empty bodies are passed through as `undefined`; callers decide
    // whether that's an error (most parse `{...}` immediately).
    return { ok: true, value: undefined as unknown as T };
  }
  try {
    return { ok: true, value: JSON.parse(read.body) as T };
  } catch {
    return { ok: false, code: "invalid_json" };
  }
}

/**
 * Standard 413 helper used by the routes when `readJsonBody` overflows.
 *
 * Note: we do NOT destroy the underlying socket — `res.end()` is sufficient.
 * Destroying mid-upload is fragile across platforms (macOS races
 * EPIPE/ECONNRESET to the client before the 413 body is delivered).
 * The matching `readJsonBody` no-op-data drain keeps the upload flowing
 * until the client emits `end`, so the server returns the response cleanly.
 */
export function respond413(res: ServerResponse, max: number): void {
  res.writeHead(413, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      ok: false,
      error: `Request body exceeds ${max}-byte limit`,
      code: "body_too_large",
    }),
  );
}

/** Standard 400 helper for malformed JSON. */
function respondInvalidJson(res: ServerResponse): void {
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
}
// END A-PR2 EDIT BLOCK

export interface RecipeRouteDeps {
  setRecipeTrustFn:
    | ((name: string, level: string) => { ok: boolean; error?: string })
    | null;
  generateRecipeFn:
    | ((prompt: string) => Promise<{
        ok: boolean;
        yaml?: string;
        warnings?: string[];
        error?: string;
        unavailable?: boolean;
      }>)
    | null;
  recipesFn: (() => Record<string, unknown>) | null;
  loadRecipeContentFn:
    | ((name: string) => { content: string; path: string } | null)
    | null;
  saveRecipeContentFn:
    | ((
        name: string,
        content: string,
      ) => {
        ok: boolean;
        path?: string;
        error?: string;
        warnings?: string[];
      })
    | null;
  deleteRecipeContentFn:
    | ((name: string) => { ok: boolean; path?: string; error?: string })
    | null;
  archiveRecipeFn:
    | ((name: string) => { ok: boolean; path?: string; error?: string })
    | null;
  duplicateRecipeFn:
    | ((name: string) => {
        ok: boolean;
        variantName?: string;
        path?: string;
        error?: string;
      })
    | null;
  promoteRecipeVariantFn:
    | ((
        variantName: string,
        targetName: string,
        options?: { force?: boolean },
      ) => Promise<{
        ok: boolean;
        path?: string;
        error?: string;
        targetExists?: boolean;
      }>)
    | null;
  lintRecipeContentFn:
    | ((content: string) => {
        ok: boolean;
        errors: string[];
        warnings: string[];
      })
    | null;
  saveRecipeFn:
    | ((draft: RecipeDraft) => { ok: boolean; path?: string; error?: string })
    | null;
  setRecipeEnabledFn:
    | ((name: string, enabled: boolean) => { ok: boolean; error?: string })
    | null;
  runsFn:
    | ((q: {
        limit?: number;
        trigger?: string;
        status?: string;
        recipe?: string;
        after?: number;
      }) => Record<string, unknown>[])
    | null;
  runDetailFn: ((seq: number) => Record<string, unknown> | null) | null;
  /**
   * Aggregate halt categories across recent runs. `sinceMs` filters to runs
   * created after `Date.now() - sinceMs`; default 7 days. `recipe` filters
   * to runs whose `recipeName` matches exactly. Returns the `HaltSummary`
   * shape from src/recipes/haltCategory.ts.
   */
  haltSummaryFn:
    | ((opts?: {
        sinceMs?: number;
        limit?: number;
        recipe?: string;
      }) => import("./recipes/haltCategory.js").HaltSummary)
    | null;
  /**
   * PR3b sibling of haltSummaryFn — same windowing shape but aggregates
   * judge-step verdicts instead. Returns the `JudgeSummary` shape from
   * src/recipes/judgeSummary.ts.
   */
  judgeSummaryFn:
    | ((opts?: {
        sinceMs?: number;
        limit?: number;
        recipe?: string;
      }) => import("./recipes/judgeSummary.js").JudgeSummary)
    | null;
  runPlanFn: ((recipeName: string) => Promise<Record<string, unknown>>) | null;
  runReplayFn:
    | ((seq: number) => Promise<{
        ok: boolean;
        newSeq?: number;
        unmockedSteps?: string[];
        error?: string;
      }>)
    | null;
  runRecipeFn:
    | ((
        name: string,
        vars?: Record<string, string>,
      ) => Promise<{ ok: boolean; taskId?: string; error?: string }>)
    | null;
  /**
   * Best-effort notification that the on-disk recipe set just changed
   * (install, save, delete, archive, …). The bridge wires this to
   * `recipeScheduler.start()` so cron-triggered recipes start firing
   * without a restart. Optional — non-bridge callers (tests, headless
   * tooling) leave it null.
   *
   * Contract:
   *   - Synchronous fire-and-forget. Implementations MUST NOT throw.
   *   - Idempotent. Multiple calls in quick succession should coalesce
   *     to at-least-once scheduler restart behaviour.
   *   - Hot path is post-success: routes invoke after the disk write,
   *     so a callback failure must never roll back the user's action.
   */
  onRecipesChangedFn: (() => void) | null;
}

/**
 * Best-effort fire of the recipe-changed notification. Wraps the
 * callback in try/catch + console.error so a misbehaving notifier
 * (most likely scheduler.start() throwing) cannot turn a successful
 * disk-write into a failed-looking HTTP response. Used by install /
 * save / delete / archive / duplicate / setEnabled / saveContent
 * routes after their respective success paths.
 */
function fireOnRecipesChanged(deps: RecipeRouteDeps): void {
  if (!deps.onRecipesChangedFn) return;
  try {
    deps.onRecipesChangedFn();
  } catch (err) {
    console.error(`[recipeRoutes] onRecipesChangedFn threw:`, err);
  }
}

/**
 * Try to handle a recipe / run-audit / template route. Returns true if
 * the route was dispatched (caller should `return` from the request
 * handler), false if no route matched.
 *
 * Must be called AFTER bearer-auth — none of these routes are public.
 */
export function tryHandleRecipeRoute(
  req: IncomingMessage,
  res: ServerResponse,
  parsedUrl: URL,
  deps: RecipeRouteDeps,
): boolean {
  const recipeNameRunMatch =
    req.method === "POST"
      ? /^\/recipes\/([^/]+)\/run$/.exec(parsedUrl.pathname)
      : null;
  if (recipeNameRunMatch) {
    // A-PR2: bounded JSON read at RECIPE_ROUTE_BODY_CAPS.run (32 KB).
    const nameFromPath = decodeURIComponent(recipeNameRunMatch[1] ?? "");
    void (async () => {
      const parsedBody = await readJsonBody<{
        vars?: Record<string, string>;
        inputs?: Record<string, string>;
      }>(req, RECIPE_ROUTE_BODY_CAPS.run);
      if (!parsedBody.ok) {
        if (parsedBody.code === "too_large") {
          respond413(res, RECIPE_ROUTE_BODY_CAPS.run);
        } else {
          respondInvalidJson(res);
        }
        return;
      }
      try {
        const parsed = parsedBody.value ?? {};
        const varsRaw = parsed.vars ?? parsed.inputs;
        const varsErr = validateRecipeVars(varsRaw);
        if (varsErr) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(varsErr));
          return;
        }
        const vars =
          varsRaw && typeof varsRaw === "object" && !Array.isArray(varsRaw)
            ? (varsRaw as Record<string, string>)
            : undefined;
        if (!deps.runRecipeFn) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error:
                "Recipe execution unavailable — requires --driver subprocess",
            }),
          );
          return;
        }
        const result = await deps.runRecipeFn(nameFromPath, vars);
        res.writeHead(result.ok ? 200 : 400, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify(result));
      } catch {
        respondInvalidJson(res);
      }
    })();
    return true;
  }

  if (parsedUrl.pathname === "/recipes/run" && req.method === "POST") {
    // A-PR2: bounded JSON read at RECIPE_ROUTE_BODY_CAPS.run (32 KB).
    void (async () => {
      const parsedBody = await readJsonBody<{
        name?: string;
        vars?: Record<string, string>;
      }>(req, RECIPE_ROUTE_BODY_CAPS.run);
      if (!parsedBody.ok) {
        if (parsedBody.code === "too_large") {
          respond413(res, RECIPE_ROUTE_BODY_CAPS.run);
        } else {
          respondInvalidJson(res);
        }
        return;
      }
      try {
        const parsed = parsedBody.value ?? {};
        const name = parsed.name;
        const varsErr = validateRecipeVars(parsed.vars);
        if (varsErr) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(varsErr));
          return;
        }
        const vars =
          parsed.vars &&
          typeof parsed.vars === "object" &&
          !Array.isArray(parsed.vars)
            ? (parsed.vars as Record<string, string>)
            : undefined;
        if (typeof name !== "string" || !name) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "name required" }));
          return;
        }
        if (!deps.runRecipeFn) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error:
                "Recipe execution unavailable — requires --driver subprocess",
            }),
          );
          return;
        }
        const result = await deps.runRecipeFn(name, vars);
        res.writeHead(result.ok ? 200 : 400, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify(result));
      } catch {
        respondInvalidJson(res);
      }
    })();
    return true;
  }

  if (parsedUrl.pathname === "/activation-metrics" && req.method === "GET") {
    try {
      const metrics = loadActivationMetrics();
      const summary = computeActivationSummary(metrics);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ metrics, summary }));
    } catch (err) {
      respond500(res, err);
    }
    return true;
  }

  if (parsedUrl.pathname === "/runs" && req.method === "GET") {
    try {
      const sp = parsedUrl.searchParams;
      const limitRaw = sp.get("limit");
      const afterRaw = sp.get("after");
      const trigger = sp.get("trigger");
      const status = sp.get("status");
      const recipe = sp.get("recipe");
      const manualRunId = sp.get("manualRunId");
      const limit = limitRaw ? Number.parseInt(limitRaw, 10) : Number.NaN;
      const after = afterRaw ? Number.parseInt(afterRaw, 10) : Number.NaN;
      const runs =
        deps.runsFn?.({
          ...(Number.isFinite(limit) && { limit }),
          ...(trigger && { trigger }),
          ...(status && { status }),
          ...(recipe && { recipe }),
          ...(manualRunId && { manualRunId }),
          ...(Number.isFinite(after) && { after }),
        }) ?? [];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ runs }));
    } catch (err) {
      respond500(res, err);
    }
    return true;
  }

  // GET /runs/halt-summary — aggregated halt categories over recent runs.
  // Drives the dashboard /runs page header widget that answers "is the
  // haltReason work surfacing real signal, or is everything 'unknown'?".
  if (parsedUrl.pathname === "/runs/halt-summary" && req.method === "GET") {
    try {
      const sp = parsedUrl.searchParams;
      const sinceMsRaw = sp.get("sinceMs");
      const limitRaw = sp.get("limit");
      const recipe = sp.get("recipe");
      const sinceMs = sinceMsRaw ? Number.parseInt(sinceMsRaw, 10) : Number.NaN;
      const limit = limitRaw ? Number.parseInt(limitRaw, 10) : Number.NaN;
      const summary = deps.haltSummaryFn?.({
        ...(Number.isFinite(sinceMs) && { sinceMs }),
        ...(Number.isFinite(limit) && { limit }),
        ...(recipe && { recipe }),
      }) ?? { total: 0, byCategory: {}, recent: [] };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(summary));
    } catch (err) {
      respond500(res, err);
    }
    return true;
  }

  // GET /runs/judge-summary — PR3b sibling of /runs/halt-summary.
  // Same query shape (sinceMs, limit, recipe), returns JudgeSummary.
  if (parsedUrl.pathname === "/runs/judge-summary" && req.method === "GET") {
    try {
      const sp = parsedUrl.searchParams;
      const sinceMsRaw = sp.get("sinceMs");
      const limitRaw = sp.get("limit");
      const recipe = sp.get("recipe");
      const sinceMs = sinceMsRaw ? Number.parseInt(sinceMsRaw, 10) : Number.NaN;
      const limit = limitRaw ? Number.parseInt(limitRaw, 10) : Number.NaN;
      const summary = deps.judgeSummaryFn?.({
        ...(Number.isFinite(sinceMs) && { sinceMs }),
        ...(Number.isFinite(limit) && { limit }),
        ...(recipe && { recipe }),
      }) ?? { total: 0, byVerdict: {}, recent: [] };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(summary));
    } catch (err) {
      respond500(res, err);
    }
    return true;
  }

  // GET /runs/:seq — single run detail (includes stepResults if present)
  const runDetailMatch =
    req.method === "GET" ? /^\/runs\/(\d+)$/.exec(parsedUrl.pathname) : null;
  if (runDetailMatch?.[1]) {
    const seq = Number.parseInt(runDetailMatch[1], 10);
    try {
      const run = deps.runDetailFn?.(seq) ?? null;
      if (!run) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ run }));
      }
    } catch (err) {
      respond500(res, err);
    }
    return true;
  }

  // POST /runs/:seq/replay — VD-4 mocked replay. Re-runs the recipe with all
  // tool/agent execution intercepted to return captured outputs from the
  // original run. No external IO, no side effects. Real-mode replay is not
  // exposed here yet — must ship separately with confirmation UX +
  // kill-switch interaction.
  const runReplayMatch =
    req.method === "POST"
      ? /^\/runs\/(\d+)\/replay$/.exec(parsedUrl.pathname)
      : null;
  if (runReplayMatch?.[1]) {
    const seq = Number.parseInt(runReplayMatch[1], 10);
    void (async () => {
      try {
        if (!deps.runReplayFn) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "replay_unavailable" }));
          return;
        }
        const result = await deps.runReplayFn(seq);
        if (result.error === "run_not_found") {
          res.writeHead(404, { "Content-Type": "application/json" });
        } else if (!result.ok) {
          res.writeHead(500, { "Content-Type": "application/json" });
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
        }
        res.end(JSON.stringify(result));
      } catch (err) {
        respond500(res, err, "runs/:seq detail");
      }
    })();
    return true;
  }

  // GET /runs/:seq/plan — dry-run plan for the recipe that produced this run
  const runPlanMatch =
    req.method === "GET"
      ? /^\/runs\/(\d+)\/plan$/.exec(parsedUrl.pathname)
      : null;
  if (runPlanMatch?.[1]) {
    const seq = Number.parseInt(runPlanMatch[1], 10);
    void (async () => {
      try {
        const run = deps.runDetailFn?.(seq) ?? null;
        if (!run) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "run_not_found" }));
          return;
        }
        if (!deps.runPlanFn) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "plan_unavailable" }));
          return;
        }
        // triggerSource appends ":agent" suffix — strip before file lookup
        const recipeName = (run.recipeName as string).replace(/:agent$/, "");
        const plan = await deps.runPlanFn(recipeName);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ plan }));
      } catch (err) {
        // #605: classify by error code, not message substring.
        // Previously `msg.includes("not found")` would mis-map any
        // deep error coincidentally containing that phrase (e.g. a
        // connector returning "credential not found") to 404. Use the
        // structured `code` on Node fs / our explicit error.code.
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT" || code === "RECIPE_NOT_FOUND") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Run not found" }));
        } else {
          respond500(res, err, "recipes plan");
        }
      }
    })();
    return true;
  }

  if (parsedUrl.pathname === "/recipes/generate" && req.method === "POST") {
    void (async () => {
      // Refill + try-consume one token. 429 if bucket is empty — `Retry-After`
      // in seconds rounds up to the next refill of one whole token.
      const now = Date.now();
      const refilled = refillBucket(
        recipeGenerateBucket,
        now,
        RECIPE_GENERATE_LIMIT_PER_MIN,
      );
      const consumed = consumeToken(refilled);
      recipeGenerateBucket = consumed.nextState;
      if (!consumed.allowed) {
        const secondsToOneToken = Math.ceil(
          ((1 - consumed.nextState.tokens) / RECIPE_GENERATE_LIMIT_PER_MIN) *
            60,
        );
        res.writeHead(429, {
          "Content-Type": "application/json",
          "Retry-After": String(Math.max(1, secondsToOneToken)),
        });
        res.end(
          JSON.stringify({
            ok: false,
            error: `Rate limit exceeded — max ${RECIPE_GENERATE_LIMIT_PER_MIN} requests per minute`,
            retryAfterSeconds: Math.max(1, secondsToOneToken),
          }),
        );
        return;
      }

      const parsedBody = await readJsonBody<{ prompt?: unknown }>(
        req,
        RECIPE_ROUTE_BODY_CAPS.generate,
      );
      if (!parsedBody.ok) {
        if (parsedBody.code === "too_large") {
          respond413(res, RECIPE_ROUTE_BODY_CAPS.generate);
        } else {
          respondInvalidJson(res);
        }
        return;
      }
      const prompt = (parsedBody.value as { prompt?: unknown } | undefined)
        ?.prompt;
      if (typeof prompt !== "string" || !prompt.trim()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: "prompt must be a non-empty string",
          }),
        );
        return;
      }
      if (!deps.generateRecipeFn) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error:
              "Recipe generation unavailable — requires --driver subprocess",
            unavailable: true,
          }),
        );
        return;
      }
      try {
        const result = await deps.generateRecipeFn(prompt.trim());
        // #605: stop collapsing every failure to 422. The dashboard
        // can't distinguish 'driver crashed' from 'user prompt refused'
        // from 'generated YAML failed lint' when everything maps to one
        // status. Use the result.errorKind discriminant when present;
        // fall back to 422 for the unstructured case.
        let status: number;
        if (result.ok) {
          status = 200;
        } else if (result.unavailable) {
          status = 503;
        } else {
          const kind = (result as { errorKind?: string }).errorKind;
          if (kind === "driver_error" || kind === "timeout") {
            status = 502; // upstream failure
          } else if (kind === "refused" || kind === "rate_limited") {
            status = 429;
          } else if (kind === "lint_failed" || kind === "invalid_yaml") {
            status = 422; // semantic generation failure
          } else {
            status = 422; // unknown — preserve legacy
          }
        }
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error(`[recipes/generate] internal error:`, err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: "Internal server error",
          }),
        );
      }
    })();
    return true;
  }

  if (req.url === "/recipes" && req.method === "POST") {
    // A-PR2: bounded JSON read at RECIPE_ROUTE_BODY_CAPS.content (256 KB).
    void (async () => {
      const parsedBody = await readJsonBody<RecipeDraft>(
        req,
        RECIPE_ROUTE_BODY_CAPS.content,
      );
      if (!parsedBody.ok) {
        if (parsedBody.code === "too_large") {
          respond413(res, RECIPE_ROUTE_BODY_CAPS.content);
        } else {
          respondInvalidJson(res);
        }
        return;
      }
      try {
        const draft = (parsedBody.value ?? ({} as RecipeDraft)) as RecipeDraft;
        if (typeof draft.name !== "string" || !draft.name) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "name required" }));
          return;
        }
        if (!deps.saveRecipeFn) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: "Recipe saving unavailable",
            }),
          );
          return;
        }
        const result = deps.saveRecipeFn(draft);
        if (result.ok) fireOnRecipesChanged(deps);
        res.writeHead(result.ok ? 201 : 400, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify(result));
      } catch {
        respondInvalidJson(res);
      }
    })();
    return true;
  }

  // PATCH /recipes/:name/trust — update trust level for a recipe.
  const recipeTrustMatch =
    req.method === "PATCH"
      ? /^\/recipes\/([^/]+)\/trust$/.exec(parsedUrl.pathname)
      : null;
  if (recipeTrustMatch?.[1]) {
    const name = decodeURIComponent(recipeTrustMatch[1]);
    void (async () => {
      const parsedBody = await readJsonBody<{ level?: unknown }>(
        req,
        RECIPE_ROUTE_BODY_CAPS.install,
      );
      if (!parsedBody.ok) {
        if (parsedBody.code === "too_large") {
          respond413(res, RECIPE_ROUTE_BODY_CAPS.install);
        } else {
          respondInvalidJson(res);
        }
        return;
      }
      const level = (parsedBody.value as { level?: unknown } | undefined)
        ?.level;
      if (typeof level !== "string" || !level) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ ok: false, error: "level (string) required" }),
        );
        return;
      }
      if (!deps.setRecipeTrustFn) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ ok: false, error: "Trust management unavailable" }),
        );
        return;
      }
      const result = deps.setRecipeTrustFn(name, level);
      res.writeHead(result.ok ? 200 : 400, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify(result));
    })();
    return true;
  }

  const recipePatchMatch = /^\/recipes\/([^/]+)$/.exec(parsedUrl.pathname);
  if (recipePatchMatch && req.method === "PATCH") {
    // A-PR2: bounded JSON read at RECIPE_ROUTE_BODY_CAPS.content (256 KB).
    const name = decodeURIComponent(recipePatchMatch[1] ?? "");
    void (async () => {
      const parsedBody = await readJsonBody<{ enabled?: boolean }>(
        req,
        RECIPE_ROUTE_BODY_CAPS.content,
      );
      if (!parsedBody.ok) {
        if (parsedBody.code === "too_large") {
          respond413(res, RECIPE_ROUTE_BODY_CAPS.content);
        } else {
          respondInvalidJson(res);
        }
        return;
      }
      try {
        const body = parsedBody.value ?? {};
        if (typeof body.enabled !== "boolean") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: "enabled (boolean) required",
            }),
          );
          return;
        }
        if (!deps.setRecipeEnabledFn) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Not available" }));
          return;
        }
        const result = deps.setRecipeEnabledFn(name, body.enabled);
        // Enable/disable changes which cron triggers should fire — the
        // RecipeScheduler honours the disabled set on every start(), so
        // re-priming after a toggle picks up the change without a restart.
        if (result.ok) fireOnRecipesChanged(deps);
        res.writeHead(result.ok ? 200 : 400, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify(result));
      } catch {
        respondInvalidJson(res);
      }
    })();
    return true;
  }

  if (parsedUrl.pathname === "/recipes/lint" && req.method === "POST") {
    // A-PR2: bounded JSON read at RECIPE_ROUTE_BODY_CAPS.content (256 KB).
    void (async () => {
      const parsedBody = await readJsonBody<{ content?: string }>(
        req,
        RECIPE_ROUTE_BODY_CAPS.content,
      );
      if (!parsedBody.ok) {
        if (parsedBody.code === "too_large") {
          respond413(res, RECIPE_ROUTE_BODY_CAPS.content);
        } else {
          respondInvalidJson(res);
        }
        return;
      }
      try {
        const body = parsedBody.value ?? {};
        if (typeof body?.content !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: "content (string) required",
            }),
          );
          return;
        }
        if (!deps.lintRecipeContentFn) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: "Recipe lint unavailable",
            }),
          );
          return;
        }
        const result = deps.lintRecipeContentFn(body.content);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch {
        respondInvalidJson(res);
      }
    })();
    return true;
  }

  // GET /recipes/:name/plan — dry-run plan for a recipe by name. Returns the
  // same RecipeDryRunPlan shape as GET /runs/:seq/plan but without needing a
  // past run seq — useful for pre-flight review before a first run.
  const recipePlanMatch =
    req.method === "GET"
      ? /^\/recipes\/([^/]+)\/plan$/.exec(parsedUrl.pathname)
      : null;
  if (recipePlanMatch?.[1]) {
    const name = decodeURIComponent(recipePlanMatch[1]);
    void (async () => {
      try {
        if (!deps.runPlanFn) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "plan_unavailable" }));
          return;
        }
        const plan = await deps.runPlanFn(name);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ plan }));
      } catch (err) {
        // #605: classify by code, not substring (see /runs/:seq/plan).
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT" || code === "RECIPE_NOT_FOUND") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Recipe not found" }));
        } else {
          respond500(res, err, "recipes plan");
        }
      }
    })();
    return true;
  }

  const recipeContentMatch = /^\/recipes\/([^/]+)$/.exec(parsedUrl.pathname);
  if (recipeContentMatch && req.method === "GET") {
    const name = decodeURIComponent(recipeContentMatch[1] ?? "");
    if (!deps.loadRecipeContentFn) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ ok: false, error: "Recipe content unavailable" }),
      );
      return true;
    }
    const result = deps.loadRecipeContentFn(name);
    if (!result) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Recipe not found" }));
      return true;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return true;
  }

  if (recipeContentMatch && req.method === "PUT") {
    // A-PR2: bounded JSON read at RECIPE_ROUTE_BODY_CAPS.content (256 KB).
    const name = decodeURIComponent(recipeContentMatch[1] ?? "");
    void (async () => {
      const parsedBody = await readJsonBody<{ content?: string }>(
        req,
        RECIPE_ROUTE_BODY_CAPS.content,
      );
      if (!parsedBody.ok) {
        if (parsedBody.code === "too_large") {
          respond413(res, RECIPE_ROUTE_BODY_CAPS.content);
        } else {
          respondInvalidJson(res);
        }
        return;
      }
      try {
        const body = parsedBody.value ?? {};
        if (typeof body.content !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: "content (string) required",
            }),
          );
          return;
        }
        if (!deps.saveRecipeContentFn) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: "Recipe content saving unavailable",
            }),
          );
          return;
        }
        const result = deps.saveRecipeContentFn(name, body.content);
        // Editing recipe YAML can change cron schedule, webhook path,
        // or trigger type entirely — re-prime the scheduler so the new
        // shape takes effect without a bridge restart.
        if (result.ok) fireOnRecipesChanged(deps);
        res.writeHead(result.ok ? 200 : 400, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify(result));
      } catch {
        respondInvalidJson(res);
      }
    })();
    return true;
  }

  if (recipeContentMatch && req.method === "DELETE") {
    const name = decodeURIComponent(recipeContentMatch[1] ?? "");
    if (!deps.deleteRecipeContentFn) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: "Recipe deletion unavailable",
        }),
      );
      return true;
    }
    const result = deps.deleteRecipeContentFn(name);
    // Deleting a cron recipe leaves an orphaned interval in the scheduler
    // until the next start() — re-prime so it goes away.
    if (result.ok) fireOnRecipesChanged(deps);
    const status = result.ok
      ? 200
      : result.error === "Recipe not found"
        ? 404
        : 400;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return true;
  }

  // POST /recipes/:name/archive — move recipe (+ sidecar) into <recipesDir>/.archive/
  const archiveMatch = /^\/recipes\/([^/]+)\/archive$/.exec(parsedUrl.pathname);
  if (archiveMatch && req.method === "POST") {
    const name = decodeURIComponent(archiveMatch[1] ?? "");
    if (!deps.archiveRecipeFn) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ ok: false, error: "Recipe archive unavailable" }),
      );
      return true;
    }
    const result = deps.archiveRecipeFn(name);
    // Archiving moves the recipe under .archive/ where the scheduler
    // ignores it — same orphan-interval cleanup needed as for delete.
    if (result.ok) fireOnRecipesChanged(deps);
    const status = result.ok
      ? 200
      : result.error === "Recipe not found"
        ? 404
        : 400;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return true;
  }

  // POST /recipes/:name/duplicate — copy recipe as next available variant name
  const duplicateMatch = /^\/recipes\/([^/]+)\/duplicate$/.exec(
    parsedUrl.pathname,
  );
  if (duplicateMatch && req.method === "POST") {
    const name = decodeURIComponent(duplicateMatch[1] ?? "");
    if (!deps.duplicateRecipeFn) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Duplicate unavailable" }));
      return true;
    }
    const result = deps.duplicateRecipeFn(name);
    // Duplication adds a new recipe file to the dir — re-prime so any
    // cron trigger inside the duplicate starts firing immediately.
    if (result.ok) fireOnRecipesChanged(deps);
    const status = result.ok
      ? 201
      : result.error === "Recipe not found"
        ? 404
        : 400;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return true;
  }

  // POST /recipes/:name/promote — promote variant to canonical name.
  // Body: { targetName: string }
  const promoteMatch = /^\/recipes\/([^/]+)\/promote$/.exec(parsedUrl.pathname);
  if (promoteMatch && req.method === "POST") {
    const variantName = decodeURIComponent(promoteMatch[1] ?? "");
    void (async () => {
      const parsedBody = await readJsonBody<{
        targetName?: string;
        force?: boolean;
      }>(req, RECIPE_ROUTE_BODY_CAPS.content);
      if (!parsedBody.ok) {
        // #605: distinguish too_large (413) from invalid JSON (400) —
        // sibling routes already do this; promote was the only handler
        // collapsing both to 400.
        if (parsedBody.code === "too_large") {
          respond413(res, RECIPE_ROUTE_BODY_CAPS.content);
        } else {
          respondInvalidJson(res);
        }
        return;
      }
      const { targetName, force } = parsedBody.value ?? {};
      if (typeof targetName !== "string" || !targetName.trim()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "targetName required" }));
        return;
      }
      if (!deps.promoteRecipeVariantFn) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Promote unavailable" }));
        return;
      }
      try {
        const result = await deps.promoteRecipeVariantFn(
          variantName,
          targetName,
          {
            force: force === true,
          },
        );
        // Promotion overwrites the canonical file with the variant's
        // contents — same scheduler refresh story as save/edit.
        if (result.ok) fireOnRecipesChanged(deps);
        const httpStatus = result.ok
          ? 200
          : result.targetExists
            ? 409
            : result.error?.includes("not found")
              ? 404
              : 400;
        res.writeHead(httpStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error(`[recipes/install] internal error:`, err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: "Internal server error",
          }),
        );
      }
    })();
    return true;
  }

  if (req.url === "/recipes" && req.method === "GET") {
    try {
      const data = deps.recipesFn?.() ?? { recipesDir: null, recipes: [] };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err) {
      respond500(res, err);
    }
    return true;
  }

  if (parsedUrl.pathname === "/templates" && req.method === "GET") {
    void (async () => {
      try {
        const now = Date.now();
        if (!templatesCache || now - templatesCacheTs > 5 * 60 * 1000) {
          const ghRes = await fetch(
            "https://raw.githubusercontent.com/patchworkos/recipes/main/index.json",
          );
          if (!ghRes.ok) {
            throw new Error(`GitHub returned ${ghRes.status}`);
          }
          // #605: validate content-type AND shape before caching.
          // Previously we just `await ghRes.json()` and cached whatever
          // came back for 5 minutes — any error page (HTML/text JSON),
          // any MITM-tampered payload, or any future GitHub schema
          // change would poison the cache for every dashboard client.
          const ct = ghRes.headers.get("content-type") ?? "";
          if (!ct.includes("application/json") && !ct.includes("text/plain")) {
            throw new Error(`GitHub returned non-JSON content-type: ${ct}`);
          }
          const raw = (await ghRes.json()) as unknown;
          if (!isWellFormedTemplatesPayload(raw)) {
            throw new Error("GitHub payload failed shape validation");
          }
          templatesCache = raw;
          templatesCacheTs = now;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(templatesCache));
      } catch (err) {
        console.error(`[recipes/templates] upstream error:`, err);
        // #605: negative cache — short window so an upstream 502 doesn't
        // pile up requests; clients see a fast 502 instead of waiting
        // for the next GH round-trip.
        templatesCacheTs = Date.now() - 5 * 60 * 1000 + 30_000; // 30s before next try
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: "Upstream fetch failed",
          }),
        );
      }
    })();
    return true;
  }

  if (parsedUrl.pathname === "/recipes/install" && req.method === "POST") {
    // ---------------------------------------------------------------------
    // BEGIN A-PR2 EDIT BLOCK — `/recipes/install` rework.
    //
    // Replaces the previous let-body-string accumulator with `readJsonBody`
    // (4 KB cap), default-denies non-github sources via
    // `CLAUDE_IDE_BRIDGE_INSTALL_ALLOWED_HOSTS`, and translates fetch errors
    // into proper 4xx status codes (R2 H-routes Bug 2 — was always 500).
    //
    // SSRF guard runs AFTER allowlist match per R3 DP-2 sub-issue: this means
    // an explicitly-allowlisted hostname STILL has to clear the SSRF check
    // (so an admin can't accidentally allowlist `localhost`).
    // ---------------------------------------------------------------------
    void (async () => {
      const parsedBody = await readJsonBody<{ source?: string }>(
        req,
        RECIPE_ROUTE_BODY_CAPS.install,
      );
      if (!parsedBody.ok) {
        if (parsedBody.code === "too_large") {
          respond413(res, RECIPE_ROUTE_BODY_CAPS.install);
        } else {
          respondInvalidJson(res);
        }
        return;
      }
      try {
        const source = parsedBody.value?.source;
        if (!source || typeof source !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Missing source field" }));
          return;
        }

        // -----------------------------------------------------------------
        // BUNDLE INSTALL DISPATCH (#130 PR A).
        //
        // `github:<owner>/<repo>/bundles/<name>` installs every recipe
        // listed in the bundle's `patchwork-bundle.json`. Plugin (`plugin`)
        // and policy template (`policy_template`) declared in the manifest
        // are surfaced as advisory-only — wiring those needs separate
        // decisions (npm-install surface, policy application UX) tracked
        // outside this PR.
        //
        // Org allowlist (#audit-thread): historically the path was hard-
        // coded to `patchworkos/recipes`. Now any allowlisted org/repo
        // can host a bundle; parse + validate via the shared helper so
        // single-recipe and bundle install share one source-of-truth.
        // -----------------------------------------------------------------
        const bundleParse = source.startsWith("github:")
          ? await (async () => {
              const { parseGithubInstallSource } = await import(
                "./recipes/githubInstallSource.js"
              );
              return parseGithubInstallSource(source);
            })()
          : null;
        if (bundleParse?.ok && bundleParse.parsed.kind === "bundle") {
          const { buildGithubRawUrl } = await import(
            "./recipes/githubInstallSource.js"
          );
          const bundleName = bundleParse.parsed.name;
          const bundleOwner = bundleParse.parsed.owner;
          const bundleRepo = bundleParse.parsed.repo;
          const manifestUrl = buildGithubRawUrl(bundleParse.parsed);

          const ctl = new AbortController();
          const timeout = setTimeout(() => ctl.abort(), 30_000);
          let manifestRes: Response;
          try {
            manifestRes = await fetch(manifestUrl, {
              signal: ctl.signal,
              redirect: "follow",
            });
          } catch (err) {
            clearTimeout(timeout);
            console.error(
              `[recipes/install] bundle manifest fetch failed:`,
              err,
            );
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                ok: false,
                error: "Bundle manifest fetch failed",
                code: "bundle_fetch_network_error",
              }),
            );
            return;
          }
          clearTimeout(timeout);
          if (!manifestRes.ok) {
            const outStatus = manifestRes.status === 404 ? 404 : 502;
            res.writeHead(outStatus, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                ok: false,
                error: `Bundle manifest at ${manifestUrl} returned ${manifestRes.status}`,
                code: "bundle_fetch_upstream_error",
                upstreamStatus: manifestRes.status,
              }),
            );
            return;
          }
          // 64 KB hard cap on manifest body — real `patchwork-bundle.json`
          // is single-digit KB; anything past 64 KB is hostile or malformed.
          const manifestBuf = await manifestRes.arrayBuffer();
          if (manifestBuf.byteLength > 64 * 1024) {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                ok: false,
                error: "Bundle manifest exceeds 64 KB cap",
                code: "bundle_manifest_too_large",
              }),
            );
            return;
          }
          let manifest: {
            name?: unknown;
            recipes?: unknown;
            plugin?: unknown;
            policy_template?: unknown;
          };
          try {
            manifest = JSON.parse(Buffer.from(manifestBuf).toString("utf-8"));
          } catch (err) {
            console.error(
              `[recipes/install] bundle manifest invalid JSON:`,
              err,
            );
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                ok: false,
                error: "Bundle manifest is not valid JSON",
                code: "bundle_manifest_invalid_json",
              }),
            );
            return;
          }
          // Validate each declared recipe basename to block traversal +
          // junk segments. `isSafeBasename` lives in the legacy recipe-
          // install command but the predicate is the right shape here.
          const { isSafeBasename } = await import(
            "./commands/recipeInstall.js"
          );
          if (
            !Array.isArray(manifest.recipes) ||
            manifest.recipes.length === 0 ||
            !manifest.recipes.every(
              (r) => typeof r === "string" && isSafeBasename(r),
            )
          ) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                ok: false,
                error:
                  "Bundle manifest must declare a non-empty `recipes` array of safe recipe names",
                code: "bundle_manifest_invalid_recipes",
              }),
            );
            return;
          }

          // Install each declared recipe. Errors are collected but don't
          // abort the loop — partial bundle install is more useful than
          // all-or-nothing when one of N recipes is broken.
          const installed: Array<{
            name: string;
            action: "created" | "replaced";
          }> = [];
          const failures: Array<{ name: string; error: string }> = [];
          const { writeFileSync, mkdirSync, unlinkSync } = await import(
            "node:fs"
          );
          const { installRecipeFromFile } = await import(
            "./recipes/installer.js"
          );
          const recipesDir = path.join(os.homedir(), ".patchwork", "recipes");
          mkdirSync(recipesDir, { recursive: true });

          for (const r of manifest.recipes as string[]) {
            // Bundle's manifest is allowed to declare recipes that
            // live in the same repo as the bundle. Build the URL with
            // the parsed owner/repo, not the hard-coded original.
            const recipeUrl = `https://raw.githubusercontent.com/${bundleOwner}/${bundleRepo}/main/recipes/${r}/${r}.yaml`;
            const recipeCtl = new AbortController();
            const recipeTimeout = setTimeout(() => recipeCtl.abort(), 30_000);
            try {
              const recipeRes = await fetch(recipeUrl, {
                signal: recipeCtl.signal,
                redirect: "follow",
              });
              clearTimeout(recipeTimeout);
              if (!recipeRes.ok) {
                failures.push({
                  name: r,
                  error: `Upstream returned ${recipeRes.status}`,
                });
                continue;
              }
              const recipeBuf = await recipeRes.arrayBuffer();
              if (recipeBuf.byteLength > 1024 * 1024) {
                failures.push({
                  name: r,
                  error: "Recipe body exceeded 1 MB cap",
                });
                continue;
              }
              const yamlText = Buffer.from(recipeBuf).toString("utf-8");
              // #605: same race-fix as /recipes/install — embed pid +
              // randomBytes so concurrent bundle installs of the same
              // recipe inside one millisecond don't collide.
              const { randomBytes: randomBytesFn } = await import(
                "node:crypto"
              );
              const tmpFile = path.join(
                os.tmpdir(),
                `patchwork-bundle-install-${process.pid}-${Date.now()}-${randomBytesFn(6).toString("hex")}-${r}.yaml`,
              );
              writeFileSync(tmpFile, yamlText, "utf-8");
              try {
                const installResult = installRecipeFromFile(tmpFile, {
                  recipesDir,
                });
                installed.push({ name: r, action: installResult.action });
              } finally {
                try {
                  unlinkSync(tmpFile);
                } catch {
                  // best-effort cleanup
                }
              }
            } catch (err) {
              clearTimeout(recipeTimeout);
              console.error(`[recipes/install] recipe "${r}" failed:`, err);
              failures.push({
                name: r,
                error: "Recipe install failed",
              });
            }
          }

          // Plugin / policy_template surfaced advisory-only.
          const advisory: Record<string, string> = {};
          if (typeof manifest.plugin === "string") {
            advisory.plugin = `Bundle declares plugin "${manifest.plugin}" — not installed; run \`npm install -g ${manifest.plugin}\` separately.`;
          }
          if (typeof manifest.policy_template === "string") {
            advisory.policy_template = `Bundle declares policy template "${manifest.policy_template}" — not applied; review and apply manually.`;
          }
          // 200 if any recipe installed; 502 otherwise. Always include both
          // arrays so callers (CLI + dashboard) can render partial-success.
          const status = installed.length > 0 ? 200 : 502;
          // Notify the scheduler so cron-trigger recipes in the bundle
          // start firing without a bridge restart. Fired once per bundle
          // (not per recipe inside) since scheduler.start() reads the
          // whole recipes dir anyway. Guarded by the partial-success
          // check — no point waking up the scheduler for a 0-installed
          // failure.
          if (installed.length > 0) fireOnRecipesChanged(deps);
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: installed.length > 0,
              kind: "bundle",
              bundleName,
              installed,
              failures,
              ...(Object.keys(advisory).length > 0 && { advisory }),
            }),
          );
          return;
        }

        let fetchUrl: string;
        let recipeName: string;
        if (source.startsWith("github:")) {
          // Parse the new generalised shape (any allowlisted org/repo)
          // instead of only `github:patchworkos/recipes/recipes/<name>`.
          // Distinguishes bad shape (400) from not-on-allowlist (403)
          // so operators can spot a config error vs. a typo.
          const { parseGithubInstallSource, buildGithubRawUrl } = await import(
            "./recipes/githubInstallSource.js"
          );
          const parsed = parseGithubInstallSource(source);
          if (!parsed.ok) {
            const status = parsed.code === "not_allowlisted" ? 403 : 400;
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                ok: false,
                error: parsed.error,
                code: parsed.code,
              }),
            );
            return;
          }
          // Bundle shape on /recipes/install (single-recipe path) is a
          // mistake — surface it explicitly rather than silently fetching
          // an unrelated URL. Bundle installs have their own code path
          // above this block.
          if (parsed.parsed.kind === "bundle") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                ok: false,
                error:
                  "Bundle source on single-recipe install. Use the bundle install path.",
                code: "bad_shape",
              }),
            );
            return;
          }
          recipeName = parsed.parsed.name;
          fetchUrl = buildGithubRawUrl(parsed.parsed);
        } else if (source.startsWith("https://")) {
          // Non-github source: must clear the env-var allowlist AND the SSRF
          // guard. Default-deny when env var unset (R3 DP-2 confirmed).
          let parsedSource: URL;
          try {
            parsedSource = new URL(source);
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                ok: false,
                error: "Invalid source URL",
                code: "invalid_source_url",
              }),
            );
            return;
          }
          // Built-in github/raw.githubusercontent hosts are always permitted
          // — they match the github: shorthand surface above.
          const ALWAYS_ALLOWED = new Set([
            "github.com",
            "www.github.com",
            "raw.githubusercontent.com",
          ]);
          const envAllowed = (
            process.env.CLAUDE_IDE_BRIDGE_INSTALL_ALLOWED_HOSTS ?? ""
          )
            .split(",")
            .map((h) => h.trim().toLowerCase())
            .filter(Boolean);
          const hostLower = parsedSource.hostname.toLowerCase();
          const inAllowlist =
            ALWAYS_ALLOWED.has(hostLower) || envAllowed.includes(hostLower);
          if (!inAllowlist) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                ok: false,
                error: `Host "${parsedSource.hostname}" is not in the install allowlist. Set CLAUDE_IDE_BRIDGE_INSTALL_ALLOWED_HOSTS to opt in.`,
                code: "host_not_allowlisted",
              }),
            );
            return;
          }
          // SSRF guard runs AFTER allowlist — defends against operator-misuse
          // (allowlisting localhost or an internal mirror).
          const ssrf = await validateSafeUrl(source);
          if (!ssrf.ok) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                ok: false,
                error: `Host blocked by SSRF guard: ${ssrf.detail ?? ssrf.reason ?? "unknown"}`,
                code: "ssrf_blocked",
              }),
            );
            return;
          }
          fetchUrl = source;
          const urlParts = fetchUrl.split("/");
          recipeName = (urlParts[urlParts.length - 1] ?? "recipe").replace(
            /\.ya?ml$/i,
            "",
          );
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: "Unsupported source format",
              code: "unsupported_source",
            }),
          );
          return;
        }

        // Bounded fetch — 1 MB hard cap on the response body so a malicious
        // host can't pin the install request open with a 1 GB stream.
        const fetchCtl = new AbortController();
        const fetchTimeout = setTimeout(() => fetchCtl.abort(), 30_000);
        let yamlRes: Response;
        try {
          yamlRes = await fetch(fetchUrl, {
            signal: fetchCtl.signal,
            redirect: "follow",
          });
        } catch (err) {
          clearTimeout(fetchTimeout);
          console.error(`[recipes/install] fetch failed:`, err);
          // Network-level error → 502 (upstream unreachable), not 500.
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: "Fetch failed",
              code: "fetch_network_error",
            }),
          );
          return;
        }
        clearTimeout(fetchTimeout);

        if (!yamlRes.ok) {
          // Translate upstream HTTP into proper status — 404→404, 403→403,
          // 5xx→502 (don't leak the upstream 500 as our 500). R2 H-routes Bug 2.
          let outStatus = 502;
          if (yamlRes.status === 404) outStatus = 404;
          else if (yamlRes.status === 403) outStatus = 403;
          else if (yamlRes.status >= 400 && yamlRes.status < 500)
            outStatus = 400;
          res.writeHead(outStatus, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: `Upstream returned ${yamlRes.status} ${yamlRes.statusText}`,
              code: "fetch_upstream_error",
              upstreamStatus: yamlRes.status,
            }),
          );
          return;
        }

        // Streamed read with 1 MB cap (mirrors `httpClient` pattern).
        const MAX_RECIPE_BYTES = 1024 * 1024;
        const reader = yamlRes.body?.getReader();
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        let truncated = false;
        if (reader) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done || value === undefined) break;
              if (totalBytes + value.byteLength > MAX_RECIPE_BYTES) {
                truncated = true;
                await reader.cancel();
                break;
              }
              chunks.push(value);
              totalBytes += value.byteLength;
            }
          } finally {
            reader.releaseLock();
          }
        }
        if (truncated) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: `Recipe body exceeded ${MAX_RECIPE_BYTES}-byte limit`,
              code: "recipe_too_large",
            }),
          );
          return;
        }
        const yamlText = Buffer.concat(
          chunks.map((c) => Buffer.from(c)),
        ).toString("utf-8");

        // #605: temp path must be unique per process+request. Previous
        // form was `Date.now()-${recipeName}` — two concurrent installs
        // of the same recipe inside one millisecond produced identical
        // paths → writeFileSync interleaved bytes, and the first finally
        // block unlinked the file the second still needed.
        const { randomBytes } = await import("node:crypto");
        const tmpFile = path.join(
          os.tmpdir(),
          `patchwork-install-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}-${recipeName}.yaml`,
        );
        const { writeFileSync, mkdirSync, unlinkSync } = await import(
          "node:fs"
        );
        writeFileSync(tmpFile, yamlText, "utf-8");
        let result: {
          action: "created" | "replaced";
          name: string;
          missingConnectors?: string[];
        };
        try {
          const recipesDir = path.join(os.homedir(), ".patchwork", "recipes");
          mkdirSync(recipesDir, { recursive: true });
          const { installRecipeFromFile } = await import(
            "./recipes/installer.js"
          );
          const installResult = installRecipeFromFile(tmpFile, {
            recipesDir,
          });
          // Soft preflight: detect which connectors the recipe uses
          // and surface the unconfigured ones as a warning. The recipe
          // is already on disk — this is a hint for the dashboard to
          // prompt "you'll need to connect Slack + Gmail to run this",
          // not a gate on the install itself. Defensive: any failure
          // here MUST NOT roll the install back, so the whole block is
          // wrapped in try/catch.
          let missingConnectors: string[] | undefined;
          try {
            const { readFileSync } = await import("node:fs");
            const installedJson = readFileSync(
              installResult.installedPath,
              "utf-8",
            );
            const recipe = JSON.parse(installedJson) as {
              steps?: unknown[];
            };
            if (Array.isArray(recipe.steps)) {
              const { detectRequiredConnectors, findMissingConnectors } =
                await import("./recipes/connectorPreflight.js");
              const required = detectRequiredConnectors(
                recipe as Parameters<typeof detectRequiredConnectors>[0],
              );
              if (required.length > 0) {
                const { handleConnectionsList } = await import(
                  "./connectors/gmail.js"
                );
                const connsResult = await handleConnectionsList();
                let connections: Array<{ id?: string; status?: string }> = [];
                try {
                  const body = JSON.parse(connsResult.body) as {
                    connectors?: Array<{ id?: string; status?: string }>;
                  };
                  connections = body.connectors ?? [];
                } catch {
                  /* malformed body — treat as no connections */
                }
                const missing = findMissingConnectors(required, connections);
                if (missing.length > 0) missingConnectors = missing;
              }
            }
          } catch (preflightErr) {
            console.warn(
              `[recipes/install] connector preflight failed (non-blocking):`,
              preflightErr,
            );
          }
          result = {
            action: installResult.action,
            name: recipeName,
            ...(missingConnectors ? { missingConnectors } : {}),
          };
        } finally {
          try {
            unlinkSync(tmpFile);
          } catch {
            // best-effort cleanup
          }
        }
        // Notify the scheduler so the new recipe's cron/webhook trigger
        // starts firing without a bridge restart. The recipe file is
        // already on disk (`writeFileSync` above), so the next
        // `scheduler.start()` will pick it up via its directory scan.
        // Errors here are logged but never surface to the caller — the
        // install itself succeeded; a scheduler restart bug must not
        // make the response look failed.
        fireOnRecipesChanged(deps);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (err) {
        // Distinguish "the recipe YAML is malformed" (user-actionable, 400)
        // from "the installer itself crashed" (server bug, 500). Before this
        // every parser error came back as the same opaque 500 — dashboards
        // surfaced "Internal server error" with no way to know what was wrong.
        const errName = err instanceof Error ? err.name : "";
        const errMsg = err instanceof Error ? err.message : String(err);
        const isParseError =
          errName === "RecipeParseError" ||
          // js-yaml / the `yaml` package both throw YAMLException / YAMLParseError.
          errName === "YAMLException" ||
          errName === "YAMLParseError" ||
          /yaml/i.test(errName);
        if (isParseError) {
          // Return only the first line of the parser message — strips any
          // embedded file path or stack frame that downstream parsers
          // sometimes include (CodeQL: js/stack-trace-exposure).
          const safeMsg =
            errMsg.split("\n", 1)[0]?.slice(0, 500) ?? "invalid recipe";
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: safeMsg,
              code: "invalid_recipe",
            }),
          );
          return;
        }
        console.error(`[recipes/install] internal install error:`, err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: "Internal server error",
            code: "install_internal_error",
          }),
        );
      }
    })();
    // END A-PR2 EDIT BLOCK
    return true;
  }

  return false;
}
