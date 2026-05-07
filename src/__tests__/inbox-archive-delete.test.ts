/**
 * Integration tests for inbox archive + permanent-delete routes.
 *
 * tryHandleInboxRoute reads from `~/.patchwork/inbox` directly via
 * `os.homedir()`. We override `process.env.HOME` (and `USERPROFILE` for
 * Windows-y env shims) to point at a tmp dir per test so writes don't
 * touch the real inbox.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tryHandleInboxRoute } from "../inboxRoutes.js";

let fakeHome = "";
let realHome: string | undefined;
let realUserProfile: string | undefined;

beforeEach(() => {
  fakeHome = mkdtempSync(path.join(os.tmpdir(), "inbox-routes-"));
  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  mkdirSync(path.join(fakeHome, ".patchwork", "inbox"), { recursive: true });
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = realUserProfile;
  if (fakeHome && existsSync(fakeHome)) {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

type Captured = { status: number; body: string };

function captureResponse(): { res: ServerResponse; result: Captured } {
  const result: Captured = { status: 0, body: "" };
  const chunks: string[] = [];
  const res = {
    writeHead: (status: number) => {
      result.status = status;
    },
    end: (chunk?: string) => {
      if (chunk) chunks.push(chunk);
      result.body = chunks.join("");
    },
  } as unknown as ServerResponse;
  return { res, result };
}

function fakeRequest(method: string): IncomingMessage {
  return { method } as IncomingMessage;
}

async function flush(): Promise<void> {
  // Route handlers are dispatched via `void (async () => {...})()` and may
  // call `await import("node:fs/promises")` internally, so we need a real
  // tick (not just the microtask queue) before asserting.
  await new Promise((r) => setTimeout(r, 30));
}

describe("inboxRoutes — archive + delete", () => {
  it("archives an inbox file into ~/.patchwork/inbox/.archive/", async () => {
    const filename = "daily-status-2026-05-07.md";
    writeFileSync(
      path.join(fakeHome, ".patchwork", "inbox", filename),
      "# daily status\n",
    );

    const { res, result } = captureResponse();
    const handled = tryHandleInboxRoute(
      fakeRequest("POST"),
      res,
      new URL(`http://x/inbox/${filename}/archive`),
    );
    expect(handled).toBe(true);
    await flush();

    expect(result.status).toBe(200);
    const body = JSON.parse(result.body) as { ok: boolean; path: string };
    expect(body.ok).toBe(true);
    expect(body.path.endsWith(`.archive/${filename}`)).toBe(true);

    const inboxDir = path.join(fakeHome, ".patchwork", "inbox");
    expect(existsSync(path.join(inboxDir, filename))).toBe(false);
    expect(existsSync(path.join(inboxDir, ".archive", filename))).toBe(true);
  });

  it("permanently deletes an inbox file via DELETE", async () => {
    const filename = "ctx-loop-test-2026-05-07.md";
    const inboxDir = path.join(fakeHome, ".patchwork", "inbox");
    writeFileSync(path.join(inboxDir, filename), "ctx output");

    const { res, result } = captureResponse();
    const handled = tryHandleInboxRoute(
      fakeRequest("DELETE"),
      res,
      new URL(`http://x/inbox/${filename}`),
    );
    expect(handled).toBe(true);
    await flush();

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).ok).toBe(true);
    expect(existsSync(path.join(inboxDir, filename))).toBe(false);
    // Hard delete — must NOT have stashed it in .archive/.
    expect(existsSync(path.join(inboxDir, ".archive", filename))).toBe(false);
  });

  it("returns 404 when archiving a missing inbox item", async () => {
    const { res, result } = captureResponse();
    tryHandleInboxRoute(
      fakeRequest("POST"),
      res,
      new URL("http://x/inbox/nope.md/archive"),
    );
    await flush();
    expect(result.status).toBe(404);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 404 when deleting a missing inbox item", async () => {
    const { res, result } = captureResponse();
    tryHandleInboxRoute(
      fakeRequest("DELETE"),
      res,
      new URL("http://x/inbox/nope.md"),
    );
    await flush();
    expect(result.status).toBe(404);
  });

  it("rejects path traversal on archive", async () => {
    const { res, result } = captureResponse();
    tryHandleInboxRoute(
      fakeRequest("POST"),
      res,
      // The filename regex requires `.md` and rejects `/`, but URL-encoded
      // slash decodes back to `/` — must still be rejected.
      new URL("http://x/inbox/%2E%2E%2Fpasswd.md/archive"),
    );
    await flush();
    expect(result.status).toBe(400);
  });

  it("does not let archive overwrite an existing archived file", async () => {
    const filename = "branch-health-2026-05-07.md";
    const inboxDir = path.join(fakeHome, ".patchwork", "inbox");
    writeFileSync(path.join(inboxDir, filename), "v1");

    const r1 = captureResponse();
    tryHandleInboxRoute(
      fakeRequest("POST"),
      r1.res,
      new URL(`http://x/inbox/${filename}/archive`),
    );
    await flush();
    expect(r1.result.status).toBe(200);

    // Re-create at the same name and archive again.
    writeFileSync(path.join(inboxDir, filename), "v2");
    const r2 = captureResponse();
    tryHandleInboxRoute(
      fakeRequest("POST"),
      r2.res,
      new URL(`http://x/inbox/${filename}/archive`),
    );
    await flush();
    expect(r2.result.status).toBe(200);

    const archived = readdirSync(path.join(inboxDir, ".archive"));
    expect(archived.filter((f) => f.startsWith("branch-health")).length).toBe(
      2,
    );
  });

  it("inbox list excludes the .archive directory", async () => {
    const filename = "active.md";
    const inboxDir = path.join(fakeHome, ".patchwork", "inbox");
    writeFileSync(path.join(inboxDir, filename), "active");

    // Archive it, then call GET /inbox.
    const arch = captureResponse();
    tryHandleInboxRoute(
      fakeRequest("POST"),
      arch.res,
      new URL(`http://x/inbox/${filename}/archive`),
    );
    await flush();

    const { res, result } = captureResponse();
    tryHandleInboxRoute(fakeRequest("GET"), res, new URL("http://x/inbox"));
    await flush();
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body) as { items: { name: string }[] };
    expect(body.items.find((i) => i.name === filename)).toBeUndefined();
  });
});
