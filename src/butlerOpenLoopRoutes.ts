/**
 * HTTP surface for Butler Loose Ends.
 *
 * Mounted behind the server's existing Bearer-token gate. The entire surface
 * is also default-off behind `butler.open-loops`.
 *
 *   GET    /butler/loops
 *   GET    /butler/loops/brief
 *   POST   /butler/loops
 *   POST   /butler/loops/:id/complete
 *   POST   /butler/loops/:id/reopen
 *   DELETE /butler/loops/:id?erase=true
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isButlerNotFoundError,
  isButlerValidationError,
} from "./butler/errors.js";
import type { ButlerOpenLoopStore } from "./butler/openLoopStore.js";
import {
  OPEN_LOOP_KINDS,
  type OpenLoopKind,
} from "./butler/openLoopTypes.js";
import { respondIfUnknownBodyKeys } from "./httpBodyValidation.js";
import { respond500 } from "./httpErrorResponse.js";
import { readJsonBody, respond413 } from "./recipeRoutes.js";

const MAX_BODY = 4 * 1024;

export interface ButlerOpenLoopRouteDeps {
  storeFn: () => ButlerOpenLoopStore;
  enabledFn: () => boolean;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function badRequest(res: ServerResponse, error: string): void {
  json(res, 400, { ok: false, error });
}

function respondStoreError(
  res: ServerResponse,
  err: unknown,
  context: string,
): void {
  if (isButlerValidationError(err)) {
    badRequest(res, err.message);
    return;
  }
  if (isButlerNotFoundError(err)) {
    json(res, 404, { ok: false, error: err.message });
    return;
  }
  respond500(res, err, context);
}

function parseLimit(url: URL): number | null {
  const raw = url.searchParams.get("limit");
  if (raw === null || raw === "") return 3;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 && n <= 20 ? n : null;
}

function parseKind(raw: string | null): OpenLoopKind | null | undefined {
  if (raw === null || raw === "") return undefined;
  return OPEN_LOOP_KINDS.has(raw as OpenLoopKind)
    ? (raw as OpenLoopKind)
    : null;
}

function disabled(res: ServerResponse): void {
  json(res, 503, {
    ok: false,
    code: "feature_disabled",
    error:
      "Butler Loose Ends is gated behind the `butler.open-loops` feature flag (default off).",
    unavailable: true,
  });
}

export function tryHandleButlerOpenLoopRoute(
  req: IncomingMessage,
  res: ServerResponse,
  parsedUrl: URL,
  deps: ButlerOpenLoopRouteDeps,
): boolean {
  const pathname = parsedUrl.pathname ?? "";
  if (!pathname.startsWith("/butler/loops")) return false;

  // Fail before reading a body or touching disk when the experiment is off.
  if (!deps.enabledFn()) {
    disabled(res);
    return true;
  }

  if (pathname === "/butler/loops" && req.method === "GET") {
    try {
      const statusRaw = parsedUrl.searchParams.get("status");
      const status =
        statusRaw === null || statusRaw === ""
          ? undefined
          : statusRaw === "open" || statusRaw === "done"
            ? statusRaw
            : null;
      if (status === null) {
        badRequest(res, "status must be open or done");
        return true;
      }
      const kind = parseKind(parsedUrl.searchParams.get("kind"));
      if (kind === null) {
        badRequest(res, "unknown kind");
        return true;
      }
      const loops = deps.storeFn().list({
        ...(status ? { status } : {}),
        ...(kind ? { kind } : {}),
      });
      json(res, 200, { ok: true, loops, count: loops.length });
    } catch (err) {
      respond500(res, err, "butler/loops/list");
    }
    return true;
  }

  if (pathname === "/butler/loops/brief" && req.method === "GET") {
    try {
      const limit = parseLimit(parsedUrl);
      if (limit === null) {
        badRequest(res, "limit must be an integer between 0 and 20");
        return true;
      }
      const brief = deps.storeFn().brief(limit);
      json(res, 200, {
        ok: true,
        ...brief,
        message:
          brief.items.length === 0
            ? "Nothing needs you."
            : `${brief.items.length} thing${brief.items.length === 1 ? "" : "s"} worth remembering`,
      });
    } catch (err) {
      respond500(res, err, "butler/loops/brief");
    }
    return true;
  }

  if (pathname === "/butler/loops" && req.method === "POST") {
    void (async () => {
      try {
        const parsed = await readJsonBody<{
          kind?: unknown;
          text?: unknown;
        }>(req, MAX_BODY);
        if (!parsed.ok) {
          if (parsed.code === "too_large") respond413(res, MAX_BODY);
          else badRequest(res, "Invalid JSON body");
          return;
        }
        const body = parsed.value ?? {};
        if (respondIfUnknownBodyKeys(res, body, ["kind", "text"])) return;
        if (
          typeof body.kind !== "string" ||
          !OPEN_LOOP_KINDS.has(body.kind as OpenLoopKind)
        ) {
          badRequest(res, "kind must be remember, promise, waiting, or future_me");
          return;
        }
        if (typeof body.text !== "string") {
          badRequest(res, "text is required and must be a string");
          return;
        }
        const loop = deps.storeFn().create({
          kind: body.kind as OpenLoopKind,
          text: body.text,
          // Provenance is stamped by the route, never caller-supplied.
          source: "http",
        });
        json(res, 201, { ok: true, loop });
      } catch (err) {
        respondStoreError(res, err, "butler/loops/create");
      }
    })();
    return true;
  }

  const completeMatch = /^\/butler\/loops\/([^/]+)\/complete$/.exec(pathname);
  if (completeMatch && req.method === "POST") {
    try {
      const id = decodeURIComponent(completeMatch[1] ?? "");
      const loop = deps.storeFn().complete(id);
      json(res, 200, { ok: true, loop });
    } catch (err) {
      respondStoreError(res, err, "butler/loops/complete");
    }
    return true;
  }

  const reopenMatch = /^\/butler\/loops\/([^/]+)\/reopen$/.exec(pathname);
  if (reopenMatch && req.method === "POST") {
    try {
      const id = decodeURIComponent(reopenMatch[1] ?? "");
      const loop = deps.storeFn().reopen(id);
      json(res, 200, { ok: true, loop });
    } catch (err) {
      respondStoreError(res, err, "butler/loops/reopen");
    }
    return true;
  }

  const deleteMatch = /^\/butler\/loops\/([^/]+)$/.exec(pathname);
  if (deleteMatch && req.method === "DELETE") {
    if (parsedUrl.searchParams.get("erase") !== "true") {
      badRequest(
        res,
        "permanent deletion requires ?erase=true; use /complete to close a loose end",
      );
      return true;
    }
    try {
      const id = decodeURIComponent(deleteMatch[1] ?? "");
      const erased = deps.storeFn().erase(id);
      json(res, 200, { ok: true, erased: true, ...erased });
    } catch (err) {
      respondStoreError(res, err, "butler/loops/erase");
    }
    return true;
  }

  return false;
}
