/**
 * Audit 2026-06-10 cli-commands-2 regression test.
 *
 * `httpsGet` in recipeInstall.ts accumulated response bytes with no cap — a
 * malicious / accidentally huge GitHub payload could stream unbounded into
 * process heap and OOM the installer. The fix adds a running byte counter that
 * destroys the response and rejects once HTTPS_GET_MAX_BYTES is exceeded.
 */

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const getMock = vi.fn();

vi.mock("node:https", () => ({
  default: { get: (...args: unknown[]) => getMock(...args) },
}));

import {
  _HTTPS_GET_MAX_BYTES_FOR_TESTS,
  _httpsGetForTests,
} from "../recipeInstall.js";

/** A fake ClientRequest whose `.end()` is a no-op. */
class FakeReq extends EventEmitter {
  end(): void {}
}

/** A fake IncomingMessage stream we can pump data into. */
class FakeRes extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  destroyed = false;
  destroy(): void {
    this.destroyed = true;
  }
}

afterEach(() => {
  getMock.mockReset();
});

describe("cli-commands-2 — httpsGet response byte cap", () => {
  it("rejects and destroys the response once the byte cap is exceeded", async () => {
    const res = new FakeRes();
    const req = new FakeReq();
    getMock.mockImplementation(
      (_url: string, _opts: unknown, cb: (r: FakeRes) => void) => {
        // Invoke the response callback on the next tick so the promise's
        // listeners are attached first.
        queueMicrotask(() => {
          cb(res);
          // Emit chunks totalling just over the cap.
          const chunk = Buffer.alloc(8 * 1024 * 1024); // 8 MB
          const chunksNeeded =
            Math.floor(_HTTPS_GET_MAX_BYTES_FOR_TESTS / chunk.length) + 2;
          for (let i = 0; i < chunksNeeded; i++) {
            res.emit("data", chunk);
            if (res.destroyed) break;
          }
        });
        return req;
      },
    );

    await expect(
      _httpsGetForTests("https://api.github.com/repos/foo/bar/contents/x"),
    ).rejects.toThrow(/too large/i);
    expect(res.destroyed).toBe(true);
  });

  it("resolves normally for a small response under the cap", async () => {
    const res = new FakeRes();
    const req = new FakeReq();
    getMock.mockImplementation(
      (_url: string, _opts: unknown, cb: (r: FakeRes) => void) => {
        queueMicrotask(() => {
          cb(res);
          res.emit("data", Buffer.from('{"ok":true}'));
          res.emit("end");
        });
        return req;
      },
    );

    const body = await _httpsGetForTests(
      "https://api.github.com/repos/foo/bar/contents/x",
    );
    expect(body.toString("utf-8")).toBe('{"ok":true}');
    expect(res.destroyed).toBe(false);
  });
});
