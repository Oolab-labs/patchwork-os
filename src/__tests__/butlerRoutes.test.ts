/**
 * Route-level tests for `/butler/*` — one per verb, plus the two that carry
 * the design rules rather than the happy path:
 *
 *   - PATCH leaves the original row byte-intact and resolves to the new value.
 *     The verb says "modify"; the store is append-only. If this ever passes by
 *     mutating, the audit answer to "what did Butler believe last Tuesday" is
 *     gone and nothing else in the suite would notice.
 *   - DELETE?erase=true destroys the words; plain DELETE does not. Two
 *     different promises to the user, so they get two assertions.
 *
 * Drives `tryHandleButlerRoute` directly with a fake req/res over a temp-dir
 * store, so no real ~/.patchwork/butler/facts.jsonl is touched.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ButlerFactStore } from "../butler/factStore.js";
import { StandingPermissionStore } from "../butler/permissionStore.js";
import type { ButlerFact } from "../butler/types.js";
import type { ButlerRouteDeps } from "../butlerRoutes.js";
import { tryHandleButlerRoute } from "../butlerRoutes.js";

let tmpDir: string;
let store: ButlerFactStore;
let deps: ButlerRouteDeps;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "butler-routes-"));
  store = new ButlerFactStore({ dir: tmpDir, logger: { warn: () => {} } });
  deps = { factStoreFn: () => store };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeReq(method: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  return req;
}

function makeRes(): {
  res: ServerResponse;
  read: () => { status: number; body: string };
} {
  let status = 0;
  let body = "";
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(b?: string) {
      body = b ?? "";
      return this;
    },
  } as unknown as ServerResponse;
  return { res, read: () => ({ status, body }) };
}

/** Fire a request; for bodied verbs, emit the body then let the handler settle. */
async function call(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ handled: boolean; status: number; json: any }> {
  const req = makeReq(method);
  const { res, read } = makeRes();
  const handled = tryHandleButlerRoute(
    req,
    res,
    new URL(`http://x${url}`),
    deps,
  );
  if (body !== undefined) {
    (req as unknown as EventEmitter).emit(
      "data",
      Buffer.from(JSON.stringify(body)),
    );
  }
  (req as unknown as EventEmitter).emit("end");
  // Two ticks: readJsonBody resolves on one, the handler continues on the next.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const { status, body: raw } = read();
  return { handled, status, json: raw ? JSON.parse(raw) : undefined };
}

/** Every row on disk, as written — the ground truth PATCH must not disturb. */
function rowsOnDisk(): ButlerFact[] {
  return readFileSync(path.join(tmpDir, "facts.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ButlerFact);
}

describe("GET /butler/facts", () => {
  it("returns current beliefs and honours minTrust", async () => {
    store.remember({
      subject: "user",
      predicate: "timezone",
      object: "Europe/Lisbon",
      channel: "user_chat",
    });
    store.remember({
      subject: "user",
      predicate: "coffee",
      object: "flat white",
      channel: "recipe_agent",
    });

    const all = await call("GET", "/butler/facts");
    expect(all.status).toBe(200);
    expect(all.json.count).toBe(2);

    // The query string must survive — the trap called out in the plan.
    const floored = await call("GET", "/butler/facts?minTrust=0.6");
    expect(floored.json.count).toBe(1);
    expect(floored.json.facts[0].predicate).toBe("timezone");
  });

  it("rejects a non-numeric minTrust rather than silently ignoring it", async () => {
    const r = await call("GET", "/butler/facts?minTrust=high");
    expect(r.status).toBe(400);
  });
});

describe("POST /butler/facts", () => {
  it("records at user tier and returns the row", async () => {
    const r = await call("POST", "/butler/facts", {
      subject: "user",
      predicate: "diet.avoid",
      object: "shellfish",
    });
    expect(r.status).toBe(201);
    expect(r.json.fact.trust).toBe(1);
    expect(r.json.fact.provenance.channel).toBe("user_chat");
  });

  it("ignores a caller-supplied channel — provenance is not a claim the body makes", async () => {
    const r = await call("POST", "/butler/facts", {
      subject: "user",
      predicate: "x",
      object: "y",
      channel: "connector",
    });
    expect(r.status).toBe(201);
    expect(r.json.fact.provenance.channel).toBe("user_chat");
  });

  it("400s on a missing field instead of storing a half-fact", async () => {
    const r = await call("POST", "/butler/facts", { subject: "user" });
    expect(r.status).toBe(400);
    expect(store.size()).toBe(0);
  });
});

describe("PATCH /butler/facts/:seq", () => {
  it("APPENDS a superseding row — the original is left byte-intact", async () => {
    const original = store.remember({
      subject: "user",
      predicate: "timezone",
      object: "Europe/Lisbon",
      channel: "user_chat",
    });
    const before = rowsOnDisk();

    const r = await call("PATCH", `/butler/facts/${original.seq}`, {
      object: "Europe/Madrid",
    });
    expect(r.status).toBe(200);
    expect(r.json.supersedes).toBe(original.seq);

    const after = rowsOnDisk();
    // The correction is an ADDITION, and row 0 is untouched down to the bytes.
    expect(after).toHaveLength(before.length + 1);
    expect(after[0]).toEqual(before[0]);
    expect(after[0]?.object).toBe("Europe/Lisbon");

    // ...and resolution now returns the new value.
    const now = await call("GET", "/butler/facts");
    expect(now.json.facts).toHaveLength(1);
    expect(now.json.facts[0].object).toBe("Europe/Madrid");
  });

  it("404s for a seq that does not exist", async () => {
    const r = await call("PATCH", "/butler/facts/999", { object: "x" });
    expect(r.status).toBe(404);
  });

  it("400s on a non-integer seq rather than coercing it", async () => {
    const r = await call("PATCH", "/butler/facts/3abc", { object: "x" });
    expect(r.status).toBe(400);
  });
});

describe("DELETE /butler/facts/:seq", () => {
  it("tombstones by default: belief gone, words still on disk", async () => {
    const f = store.remember({
      subject: "user",
      predicate: "address",
      object: "12 Rua Augusta",
      channel: "user_chat",
    });

    const r = await call("DELETE", `/butler/facts/${f.seq}`);
    expect(r.status).toBe(200);
    expect(r.json.erased).toBe(false);

    const beliefs = await call("GET", "/butler/facts");
    expect(beliefs.json.count).toBe(0);
    // The audit answer survives — that is the point of a tombstone.
    expect(readFileSync(path.join(tmpDir, "facts.jsonl"), "utf8")).toContain(
      "12 Rua Augusta",
    );
  });

  it("?erase=true destroys the words but keeps the husk", async () => {
    const f = store.remember({
      subject: "user",
      predicate: "address",
      object: "12 Rua Augusta",
      channel: "user_chat",
    });

    const r = await call("DELETE", `/butler/facts/${f.seq}?erase=true`);
    expect(r.status).toBe(200);
    expect(r.json.erased).toBe(true);

    const raw = readFileSync(path.join(tmpDir, "facts.jsonl"), "utf8");
    expect(raw).not.toContain("12 Rua Augusta");
    expect(raw).not.toContain("address");

    const rows = rowsOnDisk();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.seq).toBe(f.seq);
    expect(rows[0]?.erased).toBe(true);
    expect(typeof rows[0]?.erasedAt).toBe("number");

    // An erased row must never resolve as an empty-string belief.
    const beliefs = await call("GET", "/butler/facts");
    expect(beliefs.json.count).toBe(0);
  });

  it("erasure of one row leaves its neighbours alone", async () => {
    const keep = store.remember({
      subject: "user",
      predicate: "timezone",
      object: "Europe/Lisbon",
      channel: "user_chat",
    });
    const drop = store.remember({
      subject: "user",
      predicate: "address",
      object: "12 Rua Augusta",
      channel: "user_chat",
    });

    await call("DELETE", `/butler/facts/${drop.seq}?erase=true`);

    const rows = rowsOnDisk();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.seq === keep.seq)).toEqual(keep);
    const beliefs = await call("GET", "/butler/facts");
    expect(beliefs.json.count).toBe(1);
    expect(beliefs.json.facts[0].predicate).toBe("timezone");
  });

  it("404s for an unknown seq", async () => {
    const r = await call("DELETE", "/butler/facts/999");
    expect(r.status).toBe(404);
  });
});

describe("quarantine", () => {
  it("lists only beliefs below the originate floor", async () => {
    store.remember({
      subject: "user",
      predicate: "timezone",
      object: "Europe/Lisbon",
      channel: "user_chat",
    });
    const proposal = store.remember({
      subject: "user",
      predicate: "coffee",
      object: "flat white",
      channel: "recipe_agent",
    });

    const r = await call("GET", "/butler/quarantine");
    expect(r.status).toBe(200);
    expect(r.json.count).toBe(1);
    expect(r.json.facts[0].seq).toBe(proposal.seq);
  });

  it("does not offer a proposal that a higher-trust row already answers", async () => {
    store.remember({
      subject: "user",
      predicate: "coffee",
      object: "flat white",
      channel: "recipe_agent",
    });
    store.remember({
      subject: "user",
      predicate: "coffee",
      object: "espresso",
      channel: "user_chat",
    });

    const r = await call("GET", "/butler/quarantine");
    expect(r.json.count).toBe(0);
  });

  it("promote writes a user_confirmed row that clears the floor", async () => {
    const proposal = store.remember({
      subject: "user",
      predicate: "coffee",
      object: "flat white",
      channel: "recipe_agent",
    });

    const r = await call("POST", `/butler/quarantine/${proposal.seq}/promote`);
    expect(r.status).toBe(200);
    expect(r.json.fact.provenance.channel).toBe("user_confirmed");
    expect(r.json.fact.provenance.validated).toBe(true);
    expect(r.json.fact.trust).toBe(1);
    // The value came from the stored row, never from the request.
    expect(r.json.fact.object).toBe("flat white");

    const quarantine = await call("GET", "/butler/quarantine");
    expect(quarantine.json.count).toBe(0);
  });

  it("refuses to promote a row that was never in quarantine", async () => {
    const already = store.remember({
      subject: "user",
      predicate: "timezone",
      object: "Europe/Lisbon",
      channel: "user_chat",
    });
    const r = await call("POST", `/butler/quarantine/${already.seq}/promote`);
    expect(r.status).toBe(400);
  });

  it("refuses to promote an erased row", async () => {
    const f = store.remember({
      subject: "user",
      predicate: "coffee",
      object: "flat white",
      channel: "recipe_agent",
    });
    store.erase(f.seq);
    const r = await call("POST", `/butler/quarantine/${f.seq}/promote`);
    expect(r.status).toBe(400);
  });
});

describe("POST /butler/facts/:seq/confirm", () => {
  it("promotes a user-tier row to user_confirmed", async () => {
    const f = store.remember({
      subject: "user",
      predicate: "timezone",
      object: "Europe/Lisbon",
      channel: "user_chat",
    });
    const r = await call("POST", `/butler/facts/${f.seq}/confirm`);
    expect(r.status).toBe(200);
    expect(r.json.fact.provenance.validated).toBe(true);
    expect(r.json.fact.supersedes).toBe(f.seq);
  });
});

describe("/butler/permissions", () => {
  let permStore: StandingPermissionStore;

  beforeEach(() => {
    permStore = new StandingPermissionStore({
      dir: tmpDir,
      logger: { warn: () => {} },
    });
    deps = { factStoreFn: () => store, permissionStoreFn: () => permStore };
  });

  it("grants and lists, and never takes grantedBy from the body", async () => {
    const r = await call("POST", "/butler/permissions", {
      domains: ["tasks"],
      note: "small errands",
      // An unverified claim about a person. Must not be honoured.
      grantedBy: "wes",
    });
    expect(r.status).toBe(201);
    expect(r.json.permission.grantedBy).toBeNull();

    const list = await call("GET", "/butler/permissions");
    expect(list.json.count).toBe(1);
    expect(list.json.permissions[0].active).toBe(true);
    expect(list.json.permissions[0].note).toBe("small errands");
  });

  it("revokes without deleting — the grant stays listed, inactive", async () => {
    const granted = await call("POST", "/butler/permissions", {
      domains: ["tasks"],
    });
    const id = granted.json.permission.id;

    const revoked = await call("DELETE", `/butler/permissions/${id}`);
    expect(revoked.status).toBe(200);
    expect(revoked.json.permission.revokedAt).toBeTypeOf("number");

    const list = await call("GET", "/butler/permissions");
    // Still there — "what did I used to allow?" stays answerable.
    expect(list.json.count).toBe(1);
    expect(list.json.permissions[0].active).toBe(false);
  });

  it("404s revoking something that was never granted", async () => {
    const r = await call("DELETE", "/butler/permissions/nope");
    expect(r.status).toBe(404);
  });

  it("400s on a missing scope rather than granting everything", async () => {
    const r = await call("POST", "/butler/permissions", { note: "everything" });
    expect(r.status).toBe(400);
    expect(permStore.list()).toHaveLength(0);
  });

  it("reports every use", async () => {
    const granted = await call("POST", "/butler/permissions", {
      domains: ["issue"],
    });
    permStore.recordExercise({
      permissionId: granted.json.permission.id,
      toolName: "githubCreateIssue",
      classKey: "issue:compensable:high",
    });

    const r = await call("GET", "/butler/permissions/exercises");
    expect(r.json.count).toBe(1);
    expect(r.json.exercises[0].toolName).toBe("githubCreateIssue");
  });

  it("501s when the bridge has no permission store — never a silent empty list", async () => {
    deps = { factStoreFn: () => store };
    const r = await call("GET", "/butler/permissions");
    expect(r.status).toBe(501);
  });
});

describe("dispatch", () => {
  it("does not claim unrelated paths", () => {
    const { res } = makeRes();
    expect(
      tryHandleButlerRoute(
        makeReq("GET"),
        res,
        new URL("http://x/inbox"),
        deps,
      ),
    ).toBe(false);
  });

  it("does not claim a butler path with the wrong method", () => {
    const { res } = makeRes();
    expect(
      tryHandleButlerRoute(
        makeReq("PUT"),
        res,
        new URL("http://x/butler/facts"),
        deps,
      ),
    ).toBe(false);
  });
});
