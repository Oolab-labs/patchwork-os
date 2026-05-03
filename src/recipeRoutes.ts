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
import type { RecipeDraft } from "./recipesHttp.js";
import { validateSafeUrl } from "./ssrfGuard.js";

// 5-minute cache of the public template registry from the patchworkos/recipes
// GitHub repo. Process-wide; hoisted out of Server class state.
let templatesCache: unknown = null;
let templatesCacheTs = 0;

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
 * Read an HTTP request body up to `max` bytes, parse as JSON, return result.
 *
 * Returns one of three discriminated shapes:
 *   - `{ ok: true, value }` — body parsed successfully.
 *   - `{ ok: false, code: "too_large" }` — body exceeded `max`; request was
 *     destroyed eagerly and the response should be 413.
 *   - `{ ok: false, code: "invalid_json" }` — body was valid bytes but failed
 *     `JSON.parse`; response should be 400.
 *
 * Bytes are accumulated into a single Buffer so the helper can enforce the
 * cap incrementally — a 1 GB upload is rejected after the first overflowing
 * chunk rather than after the full body lands in memory.
 */
export function readJsonBody<T = unknown>(
  req: IncomingMessage,
  max: number,
): Promise<
  { ok: true; value: T } | { ok: false; code: "too_large" | "invalid_json" }
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
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (raw.length === 0) {
        // Empty bodies are passed through as `undefined`; callers decide
        // whether that's an error (most parse `{...}` immediately).
        resolve({ ok: true, value: undefined as unknown as T });
        return;
      }
      try {
        resolve({ ok: true, value: JSON.parse(raw) as T });
      } catch {
        resolve({ ok: false, code: "invalid_json" });
      }
    };

    const onError = () => {
      if (aborted) return;
      aborted = true;
      resolve({ ok: false, code: "invalid_json" });
    };

    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
  });
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
function respond413(res: ServerResponse, max: number): void {
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
                "Recipe execution unavailable — requires --claude-driver subprocess",
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
                "Recipe execution unavailable — requires --claude-driver subprocess",
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
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
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
      const limit = limitRaw ? Number.parseInt(limitRaw, 10) : Number.NaN;
      const after = afterRaw ? Number.parseInt(afterRaw, 10) : Number.NaN;
      const runs =
        deps.runsFn?.({
          ...(Number.isFinite(limit) && { limit }),
          ...(trigger && { trigger }),
          ...(status && { status }),
          ...(recipe && { recipe }),
          ...(Number.isFinite(after) && { after }),
        }) ?? [];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ runs }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
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
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
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
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
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
        const msg = err instanceof Error ? err.message : String(err);
        const status =
          msg.includes("not found") || msg.includes("ENOENT") ? 404 : 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
      }
    })();
    return true;
  }

  if (parsedUrl.pathname === "/recipes/generate" && req.method === "POST") {
    void (async () => {
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
              "Recipe generation unavailable — requires --claude-driver subprocess",
            unavailable: true,
          }),
        );
        return;
      }
      try {
        const result = await deps.generateRecipeFn(prompt.trim());
        const status = result.ok ? 200 : result.unavailable ? 503 : 422;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
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
    const status = result.ok
      ? 200
      : result.error === "Recipe not found"
        ? 404
        : 400;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return true;
  }

  if (req.url === "/recipes" && req.method === "GET") {
    try {
      const data = deps.recipesFn?.() ?? { recipesDir: null, recipes: [] };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
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
          templatesCache = (await ghRes.json()) as unknown;
          templatesCacheTs = now;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(templatesCache));
      } catch (err) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
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
        const source = (parsedBody.value ?? {}).source;
        if (!source || typeof source !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Missing source field" }));
          return;
        }
        const githubPrefix = "github:patchworkos/recipes/recipes/";
        let fetchUrl: string;
        let recipeName: string;
        if (source.startsWith(githubPrefix)) {
          recipeName = source.slice(githubPrefix.length);
          // The constructed URL is internal — recipeName must be a safe
          // single-segment so we don't end up encoding `../etc/passwd` into
          // the path. Reuse the strict basename predicate from `recipeInstall`.
          const { isSafeBasename } = await import(
            "./commands/recipeInstall.js"
          );
          if (!isSafeBasename(recipeName)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                ok: false,
                error: "Invalid recipe name in source",
              }),
            );
            return;
          }
          fetchUrl = `https://raw.githubusercontent.com/patchworkos/recipes/main/recipes/${recipeName}/${recipeName}.yaml`;
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
            process.env["CLAUDE_IDE_BRIDGE_INSTALL_ALLOWED_HOSTS"] ?? ""
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
          // Network-level error → 502 (upstream unreachable), not 500.
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
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

        const tmpFile = path.join(
          os.tmpdir(),
          `patchwork-install-${Date.now()}-${recipeName}.yaml`,
        );
        const { writeFileSync, mkdirSync, unlinkSync } = await import(
          "node:fs"
        );
        writeFileSync(tmpFile, yamlText, "utf-8");
        let result: { action: "created" | "replaced"; name: string };
        try {
          const recipesDir = path.join(os.homedir(), ".patchwork", "recipes");
          mkdirSync(recipesDir, { recursive: true });
          const { installRecipeFromFile } = await import(
            "./recipes/installer.js"
          );
          const installResult = installRecipeFromFile(tmpFile, {
            recipesDir,
          });
          result = { action: installResult.action, name: recipeName };
        } finally {
          try {
            unlinkSync(tmpFile);
          } catch {
            // best-effort cleanup
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (err) {
        // Truly unexpected — installer crash, manifest validation throw, etc.
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
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
