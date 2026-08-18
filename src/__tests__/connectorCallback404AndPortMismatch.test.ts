/**
 * #1266 — two operator-facing correctness fixes.
 *
 * Both are about a failure being reported as the WRONG KIND of failure, which
 * costs an operator the whole debugging session: they go and check the thing
 * the message named, find it fine, and never see the real cause.
 */

import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tryHandlePublicConnectorRoute } from "../connectorRoutes.js";
import {
  _resetPortMismatchWarning,
  warnIfCallbackPortMismatch,
} from "../connectors/connectorRedirectUri.js";
import { oauthConnectorIds } from "../connectors/connectorRegistry.js";

function makeReq(method: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  return req;
}

function makeRes(): {
  res: ServerResponse;
  status: () => number;
  body: () => string;
  done: Promise<void>;
} {
  let status = 0;
  const chunks: string[] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    end(c?: string) {
      if (c) chunks.push(c);
      resolveDone();
      return this;
    },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => chunks.join(""), done };
}

describe("unknown connector on a callback path 404s, it does not 401", () => {
  it("claims the request and answers 404, naming the slug", () => {
    // Before: the dispatcher returned false, the request fell through to the
    // bearer gate, and answered 401. A vendor's OAuth redirect never carries a
    // Patchwork bearer, so that 401 was GUARANTEED — a typo'd redirect_uri
    // presented as an authentication failure.
    const { res, status, body } = makeRes();
    const handled = tryHandlePublicConnectorRoute(
      makeReq("GET"),
      res,
      new URL("http://x/connections/githbu/callback?code=abc"),
    );
    expect(handled).toBe(true);
    expect(status()).toBe(404);
    // Naming the slug is what ends the investigation.
    expect(body()).toContain("githbu");
  });

  it("does NOT claim a real connector's callback (control)", async () => {
    // What this actually guards is POSITION, established by probing rather
    // than assumed. Widening the new branch's condition to `slug !== null`
    // changes nothing — it sits after every real handler, so a known slug has
    // already returned true before reaching it, and that mutation is simply
    // unreachable.
    //
    // The live risk is a later refactor HOISTING the check (tidying all the
    // path-shape logic to the top of the function is the natural instinct).
    // Then every real callback 404s and OAuth breaks completely. Probed: with
    // the check moved to the top of the dispatcher, this test fails.
    const slug = oauthConnectorIds()[0] as string;
    const { res, done: res_done } = makeRes();
    const handled = tryHandlePublicConnectorRoute(
      makeReq("GET"),
      res,
      new URL(`http://x/connections/${slug}/callback?code=abc&state=x`),
    );
    expect(handled).toBe(true);
    // Claimed by the real handler, not the 404 branch.
    const probe = makeRes();
    tryHandlePublicConnectorRoute(
      makeReq("GET"),
      probe.res,
      new URL(`http://x/connections/${slug}/callback?code=abc&state=x`),
    );
    // `await` before reading the status, for two independent reasons (#1386).
    //
    // 1. Correctness of THIS assertion. The real handler is a fire-and-forget
    //    `void (async () => { await import(...) })()`, so nothing has been
    //    written when it returns. `status` starts at 0, and `0 !== 404` — the
    //    check passed even if the handler never ran at all. It asserted the
    //    absence of a synchronous write, which no code path could produce.
    // 2. The dynamic import outlived the test. Whichever import had not
    //    resolved at environment teardown threw `EnvironmentTeardownError`
    //    and failed the CI step after every test reported passing.
    //
    // Asserting a real status is what makes the leak impossible to reopen:
    // drop the await and `0` is not a status any handler returns.
    await Promise.all([probe.done, res_done]);
    expect(probe.status()).toBeGreaterThan(0);
    expect(probe.status()).not.toBe(404);
  });

  it("ignores paths that are not callbacks", () => {
    const { res } = makeRes();
    expect(
      tryHandlePublicConnectorRoute(
        makeReq("GET"),
        res,
        new URL("http://x/connections/githbu/test"),
      ),
    ).toBe(false);
  });
});

describe("warnIfCallbackPortMismatch", () => {
  const KEYS = [
    "PATCHWORK_DASHBOARD_URL",
    "PATCHWORK_BRIDGE_URL",
    "PATCHWORK_BRIDGE_PORT",
  ] as const;
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    _resetPortMismatchWarning();
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("warns when the bound port differs from the advertised one", () => {
    const log = vi.fn();
    warnIfCallbackPortMismatch(54321, log);
    expect(log).toHaveBeenCalledTimes(1);
    const msg = log.mock.calls[0]?.[0] as string;
    // Both numbers must appear — a message naming only one leaves the reader
    // to work out which side is wrong.
    expect(msg).toContain("54321");
    expect(msg).toContain("3101");
    // And it must say what to DO. This is the whole value over a bare warning.
    expect(msg).toContain("--port 3101");
  });

  it("stays silent when they agree (control)", () => {
    const log = vi.fn();
    warnIfCallbackPortMismatch(3101, log);
    expect(log).not.toHaveBeenCalled();
  });

  it("stays silent when the operator configured a base URL", () => {
    // A dashboard on :3200 fronting a bridge on :3101 is the DOCUMENTED
    // topology. Warning there would fire on a correct configuration, which is
    // how a diagnostic gets ignored.
    process.env.PATCHWORK_DASHBOARD_URL = "https://example.test/dashboard";
    const log = vi.fn();
    warnIfCallbackPortMismatch(3101, log);
    expect(log).not.toHaveBeenCalled();

    _resetPortMismatchWarning();
    delete process.env.PATCHWORK_DASHBOARD_URL;
    process.env.PATCHWORK_BRIDGE_URL = "https://bridge.example.test";
    const log2 = vi.fn();
    warnIfCallbackPortMismatch(9999, log2);
    expect(log2).not.toHaveBeenCalled();
  });

  it("honours PATCHWORK_BRIDGE_PORT as the advertised port", () => {
    process.env.PATCHWORK_BRIDGE_PORT = "4444";
    const log = vi.fn();
    warnIfCallbackPortMismatch(4444, log);
    expect(log).not.toHaveBeenCalled();

    _resetPortMismatchWarning();
    const log2 = vi.fn();
    warnIfCallbackPortMismatch(5555, log2);
    expect(log2).toHaveBeenCalledTimes(1);
    expect(log2.mock.calls[0]?.[0]).toContain("4444");
  });

  it("warns at most once", () => {
    const log = vi.fn();
    warnIfCallbackPortMismatch(54321, log);
    warnIfCallbackPortMismatch(54321, log);
    warnIfCallbackPortMismatch(11111, log);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
