/**
 * Butler fact routes — the first HTTP surface over `src/butler/`.
 *
 * Until this file, the fact store was reachable only from an MCP client, so
 * nothing but an agent could read or correct what Butler believed about its
 * user. That is backwards: the human is the highest-trust channel in the
 * design (`PROVENANCE_TIER.user_chat === 1.0`) and had no way in.
 *
 *   GET    /butler/facts?minTrust=&all=     current beliefs (or every row)
 *   POST   /butler/facts                    record, at user tier
 *   PATCH  /butler/facts/:seq               correct — APPENDS a superseding row
 *   POST   /butler/facts/:seq/confirm       promote a proposal to user-affirmed
 *   DELETE /butler/facts/:seq[?erase=true]  tombstone, or GDPR erasure
 *   GET    /butler/quarantine               beliefs below the originate floor
 *   POST   /butler/quarantine/:seq/promote  requires an explicit human act
 *
 * Mounted after the Bearer gate in server.ts, like `tryHandleInboxRoute`.
 *
 * THREE THINGS THAT ARE NOT OBVIOUS FROM THE VERBS
 *
 * 1. `PATCH` does not patch. The store is append-only; a correction is a new
 *    row carrying `supersedes`, and the original stays readable. The HTTP verb
 *    is chosen for the caller's sake and the implementation must not honour
 *    its usual meaning. Asserted by a test.
 *
 * 2. `DELETE` defaults to a TOMBSTONE, which stops the belief resolving and
 *    leaves the words on disk. That is right for audit and wrong for GDPR
 *    Art. 17, so erasure is a separate, explicit `?erase=true` — never the
 *    default, because "stop believing this" and "destroy this" are different
 *    requests and a caller that meant the first should not silently get the
 *    second. See `ButlerFactStore.erase`.
 *
 * 3. Everything written here is `user_chat` tier (1.0) EXCEPT nothing — there
 *    is no route parameter for provenance, deliberately. The channel is a
 *    property of how the bytes arrived, not a claim the payload gets to make.
 *    An agent that could POST `{"channel":"user_chat"}` would defeat the tier
 *    ceiling that the whole store is built on.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ButlerFactStore } from "./butler/factStore.js";
import type { StandingPermissionStore } from "./butler/permissionStore.js";
import { isActive } from "./butler/standingPermission.js";
import type { ButlerFact } from "./butler/types.js";
import { ORIGINATE_THRESHOLD } from "./butler/types.js";
import { respond500 } from "./httpErrorResponse.js";
import { readJsonBody, respond413 } from "./recipeRoutes.js";

/** A belief is a sentence. 16 KB is generous for subject+predicate+object. */
const MAX_BODY = 16 * 1024;

export interface ButlerRouteDeps {
  /** The process-wide store. Injected so tests can point at a temp dir. */
  factStoreFn: () => ButlerFactStore;
  /** Standing-permission record. Absent ⇒ the permission routes 501 rather
   *  than silently reporting "no permissions", which would read as "you have
   *  granted nothing" when the truth is "this bridge cannot tell you". */
  permissionStoreFn?: () => StandingPermissionStore;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function badRequest(res: ServerResponse, error: string): void {
  json(res, 400, { ok: false, error });
}

/**
 * Parse a `:seq` path segment. Rejects anything that is not a positive
 * integer — `Number.parseInt` alone would accept "3abc" and act on fact 3,
 * which is the wrong fact to erase.
 */
function parseSeq(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Optional numeric query param, validated. Returns `undefined` if absent. */
function numberParam(
  url: URL,
  name: string,
): { ok: true; value: number | undefined } | { ok: false } {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return { ok: true, value: undefined };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false };
  return { ok: true, value: n };
}

/**
 * Rows a caller is allowed to see. The store's `all()` includes erased husks;
 * they carry no content but returning them invites a UI to render an empty
 * row where a belief used to be. Callers asking for the audit view get the
 * husk WITH its `erased` flag so the erasure is visible as an event, but the
 * normal belief view never sees them (`resolveFacts` drops them).
 */
function auditView(store: ButlerFactStore): ButlerFact[] {
  return store.all();
}

export function tryHandleButlerRoute(
  req: IncomingMessage,
  res: ServerResponse,
  parsedUrl: URL,
  deps: ButlerRouteDeps,
): boolean {
  const pathname = parsedUrl.pathname ?? "";
  if (!pathname.startsWith("/butler/")) return false;

  // ── GET /butler/facts ─────────────────────────────────────────────────────
  if (pathname === "/butler/facts" && req.method === "GET") {
    try {
      const store = deps.factStoreFn();
      const all = parsedUrl.searchParams.get("all") === "true";
      if (all) {
        const facts = auditView(store);
        json(res, 200, { ok: true, facts, count: facts.length });
        return true;
      }
      const minTrust = numberParam(parsedUrl, "minTrust");
      if (!minTrust.ok) {
        badRequest(res, "minTrust must be a number");
        return true;
      }
      if (
        minTrust.value !== undefined &&
        (minTrust.value < 0 || minTrust.value > 1)
      ) {
        badRequest(res, "minTrust must be between 0 and 1");
        return true;
      }
      const facts = store.recall(
        minTrust.value === undefined ? {} : { minTrust: minTrust.value },
      );
      json(res, 200, { ok: true, facts, count: facts.length });
    } catch (err) {
      respond500(res, err);
    }
    return true;
  }

  // ── POST /butler/facts ────────────────────────────────────────────────────
  if (pathname === "/butler/facts" && req.method === "POST") {
    void (async () => {
      try {
        const parsed = await readJsonBody<{
          subject?: unknown;
          predicate?: unknown;
          object?: unknown;
          contentConfidence?: unknown;
          validFrom?: unknown;
          validUntil?: unknown;
        }>(req, MAX_BODY);
        if (!parsed.ok) {
          if (parsed.code === "too_large") respond413(res, MAX_BODY);
          else badRequest(res, "Invalid JSON body");
          return;
        }
        const body = parsed.value ?? {};
        if (
          typeof body.subject !== "string" ||
          typeof body.predicate !== "string" ||
          typeof body.object !== "string"
        ) {
          badRequest(res, "subject, predicate and object are required strings");
          return;
        }
        const cc = body.contentConfidence;
        if (cc !== undefined && typeof cc !== "number") {
          badRequest(res, "contentConfidence must be a number");
          return;
        }
        const fact = deps.factStoreFn().remember({
          subject: body.subject,
          predicate: body.predicate,
          object: body.object,
          // Not caller-supplied. See the header comment, point 3.
          channel: "user_chat",
          ...(typeof cc === "number" && { contentConfidence: cc }),
          ...(typeof body.validFrom === "number" && {
            validFrom: body.validFrom,
          }),
          ...(typeof body.validUntil === "number" && {
            validUntil: body.validUntil,
          }),
        });
        json(res, 201, { ok: true, fact });
      } catch (err) {
        // `remember` throws on caller-fixable input (too long, NUL bytes,
        // confidence out of range). Those are 400s, not 500s.
        badRequest(res, err instanceof Error ? err.message : String(err));
      }
    })();
    return true;
  }

  const seqMatch = /^\/butler\/facts\/([^/]+)$/.exec(pathname);

  // ── PATCH /butler/facts/:seq — correct, by appending ──────────────────────
  if (seqMatch && req.method === "PATCH") {
    void (async () => {
      try {
        const seq = parseSeq(seqMatch[1] ?? "");
        if (seq === null) {
          badRequest(res, "seq must be a positive integer");
          return;
        }
        const parsed = await readJsonBody<{
          object?: unknown;
          contentConfidence?: unknown;
        }>(req, MAX_BODY);
        if (!parsed.ok) {
          if (parsed.code === "too_large") respond413(res, MAX_BODY);
          else badRequest(res, "Invalid JSON body");
          return;
        }
        const body = parsed.value ?? {};
        if (typeof body.object !== "string") {
          badRequest(res, "object is required and must be a string");
          return;
        }
        const store = deps.factStoreFn();
        const target = store.all().find((f) => f.seq === seq);
        if (!target) {
          json(res, 404, { ok: false, error: `no fact with seq ${seq}` });
          return;
        }
        const cc = body.contentConfidence;
        if (cc !== undefined && typeof cc !== "number") {
          badRequest(res, "contentConfidence must be a number");
          return;
        }
        // A NEW row. The original keeps its content, its trust and its place
        // in the log — "what did Butler believe last Tuesday" must still have
        // an answer after a correction.
        const fact = store.remember({
          subject: target.subject,
          predicate: target.predicate,
          object: body.object,
          channel: "user_chat",
          supersedes: seq,
          ...(typeof cc === "number" && { contentConfidence: cc }),
        });
        json(res, 200, { ok: true, fact, supersedes: seq });
      } catch (err) {
        badRequest(res, err instanceof Error ? err.message : String(err));
      }
    })();
    return true;
  }

  // ── DELETE /butler/facts/:seq[?erase=true] ────────────────────────────────
  if (seqMatch && req.method === "DELETE") {
    try {
      const seq = parseSeq(seqMatch[1] ?? "");
      if (seq === null) {
        badRequest(res, "seq must be a positive integer");
        return true;
      }
      const store = deps.factStoreFn();
      const erase = parsedUrl.searchParams.get("erase") === "true";
      if (erase) {
        const fact = store.erase(seq);
        json(res, 200, { ok: true, erased: true, fact });
      } else {
        const tombstone = store.forget(seq, "user_chat");
        json(res, 200, { ok: true, erased: false, tombstone });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/^no fact with seq/.test(msg))
        json(res, 404, { ok: false, error: msg });
      else respond500(res, err);
    }
    return true;
  }

  // ── POST /butler/facts/:seq/confirm ───────────────────────────────────────
  const confirmMatch = /^\/butler\/facts\/([^/]+)\/confirm$/.exec(pathname);
  if (confirmMatch && req.method === "POST") {
    const seq = parseSeq(confirmMatch[1] ?? "");
    if (seq === null) {
      badRequest(res, "seq must be a positive integer");
      return true;
    }
    respondWithPromotion(res, deps, seq, { requireBelowFloor: false });
    return true;
  }

  // ── GET /butler/quarantine ────────────────────────────────────────────────
  if (pathname === "/butler/quarantine" && req.method === "GET") {
    try {
      // Resolve with no floor, then keep the winners that sit below it. Doing
      // it this way (rather than scanning raw rows) means a low-trust claim is
      // NOT shown when a higher-trust row already answers the same
      // subject+predicate — there is nothing to promote when we already
      // believe something better, and offering it would invite the user to
      // "confirm" a proposal that is already moot.
      const facts = deps
        .factStoreFn()
        .recall({ minTrust: 0 })
        .filter((f) => f.trust < ORIGINATE_THRESHOLD);
      json(res, 200, { ok: true, facts, count: facts.length });
    } catch (err) {
      respond500(res, err);
    }
    return true;
  }

  // ── POST /butler/quarantine/:seq/promote ──────────────────────────────────
  const promoteMatch = /^\/butler\/quarantine\/([^/]+)\/promote$/.exec(
    pathname,
  );
  if (promoteMatch && req.method === "POST") {
    const seq = parseSeq(promoteMatch[1] ?? "");
    if (seq === null) {
      badRequest(res, "seq must be a positive integer");
      return true;
    }
    respondWithPromotion(res, deps, seq, { requireBelowFloor: true });
    return true;
  }

  // ── Standing permissions ──────────────────────────────────────────────────
  //
  // GET  /butler/permissions            every grant ever made, newest first
  // POST /butler/permissions            grant one
  // DELETE /butler/permissions/:id      withdraw (the record is KEPT)
  // GET  /butler/permissions/exercises  every use — "done without asking"
  //
  // The list includes revoked and expired grants, with an `active` flag. A page
  // that could only show live grants could not answer "what did I used to
  // allow?", which is half the reason the record is append-only.
  if (pathname.startsWith("/butler/permissions")) {
    if (!deps.permissionStoreFn) {
      json(res, 501, {
        ok: false,
        error: "standing permissions are not available on this bridge",
      });
      return true;
    }
    const store = deps.permissionStoreFn();

    if (pathname === "/butler/permissions" && req.method === "GET") {
      try {
        const now = Date.now();
        const permissions = store
          .list()
          .map((p) => ({ ...p, active: isActive(p, now) }));
        json(res, 200, { ok: true, permissions, count: permissions.length });
      } catch (err) {
        respond500(res, err);
      }
      return true;
    }

    if (pathname === "/butler/permissions/exercises" && req.method === "GET") {
      try {
        const exercises = store.exercises();
        json(res, 200, { ok: true, exercises, count: exercises.length });
      } catch (err) {
        respond500(res, err);
      }
      return true;
    }

    if (pathname === "/butler/permissions" && req.method === "POST") {
      void (async () => {
        try {
          const parsed = await readJsonBody<{
            domains?: unknown;
            note?: unknown;
            expiresAt?: unknown;
            perDay?: unknown;
            magnitudeBand?: unknown;
          }>(req, MAX_BODY);
          if (!parsed.ok) {
            if (parsed.code === "too_large") respond413(res, MAX_BODY);
            else badRequest(res, "Invalid JSON body");
            return;
          }
          const body = parsed.value ?? {};
          if (
            !Array.isArray(body.domains) ||
            !body.domains.every((d) => typeof d === "string")
          ) {
            badRequest(res, "domains must be an array of strings");
            return;
          }
          const ceiling: NonNullable<
            Parameters<StandingPermissionStore["grant"]>[0]["ceiling"]
          > = {};
          if (typeof body.perDay === "number") ceiling.perDay = body.perDay;
          if (
            body.magnitudeBand === "band<=50" ||
            body.magnitudeBand === "band<=500" ||
            body.magnitudeBand === "band>500"
          )
            ceiling.magnitudeBand = body.magnitudeBand;

          const permission = store.grant({
            scope: { domains: body.domains as string[] },
            // grantedBy is NOT taken from the body. The bridge authenticates one
            // shared token, so nothing here can establish who is asking, and a
            // caller-supplied name would be an unverified claim written into an
            // audit record (ADR-0020). It stays null until per-member auth.
            ...(typeof body.note === "string" && { note: body.note }),
            ...(typeof body.expiresAt === "number" && {
              expiresAt: body.expiresAt,
            }),
            ...(Object.keys(ceiling).length > 0 && { ceiling }),
          });
          json(res, 201, { ok: true, permission });
        } catch (err) {
          badRequest(res, err instanceof Error ? err.message : String(err));
        }
      })();
      return true;
    }

    const revokeMatch = /^\/butler\/permissions\/([^/]+)$/.exec(pathname);
    if (revokeMatch && req.method === "DELETE") {
      try {
        const permission = store.revoke(
          decodeURIComponent(revokeMatch[1] ?? ""),
        );
        // Revoked, not deleted: the row stays so "allowed for a while, then
        // withdrawn" remains answerable.
        json(res, 200, { ok: true, permission });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/^no standing permission/.test(msg))
          json(res, 404, { ok: false, error: msg });
        else respond500(res, err);
      }
      return true;
    }
  }

  return false;
}

/**
 * The one operation that RAISES trust, shared by `confirm` and `promote`.
 *
 * It is a POST with no body on purpose: the act of calling it IS the evidence.
 * Nothing about the promoted row is taken from the request, so a caller cannot
 * confirm one fact into a different fact's value.
 *
 * `requireBelowFloor` distinguishes the two callers. `promote` is the
 * quarantine path and refuses a row that was never quarantined, so a UI bug
 * cannot turn "promote from quarantine" into a general trust escalator.
 */
function respondWithPromotion(
  res: ServerResponse,
  deps: ButlerRouteDeps,
  seq: number,
  opts: { requireBelowFloor: boolean },
): void {
  try {
    const store = deps.factStoreFn();
    const target = store.all().find((f) => f.seq === seq);
    if (!target) {
      json(res, 404, { ok: false, error: `no fact with seq ${seq}` });
      return;
    }
    if (target.erased) {
      badRequest(res, `fact ${seq} was erased and cannot be promoted`);
      return;
    }
    if (target.retracts !== undefined) {
      badRequest(res, `fact ${seq} is a retraction, not a belief`);
      return;
    }
    if (opts.requireBelowFloor && target.trust >= ORIGINATE_THRESHOLD) {
      badRequest(res, `fact ${seq} is not in quarantine`);
      return;
    }
    const fact = store.remember({
      subject: target.subject,
      predicate: target.predicate,
      object: target.object,
      // A positive human act — the only channel that sets `validated: true`.
      channel: "user_confirmed",
      supersedes: seq,
    });
    json(res, 200, { ok: true, fact, promoted: seq });
  } catch (err) {
    respond500(res, err);
  }
}
