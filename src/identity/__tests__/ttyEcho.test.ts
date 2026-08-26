/**
 * The echo muter must not swallow the stream it was meant to restore.
 *
 * `members set-password` muted stdout to hide a typed password and restored it
 * by reading `process.stdout.write` back — which, because readline's `output`
 * IS `process.stdout`, read back the no-op it had just installed. stdout
 * stayed muted for the rest of the process, so the "Confirm:" prompt was
 * invisible and the operator confirmed blind.
 *
 * The alias case is the one that matters: a test using a standalone object
 * passes against the broken version.
 */

import { describe, expect, it } from "vitest";
import { type EchoTarget, muteEcho } from "../ttyEcho.js";

function recorder(): EchoTarget & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    write(chunk: string) {
      seen.push(chunk);
      return true;
    },
  };
}

describe("muteEcho", () => {
  it("suppresses writes while muted and restores them after", () => {
    const out = recorder();
    out.write("before");
    const restore = muteEcho(out);
    out.write("secret");
    restore();
    out.write("after");
    expect(out.seen).toEqual(["before", "after"]);
  });

  it("restores through an ALIAS of the same stream", () => {
    // readline holds `output === process.stdout`. Muting through one name and
    // restoring through the other is exactly the shape that broke.
    const out = recorder();
    const alias = out;
    const restore = muteEcho(alias);
    out.write("secret");
    restore();
    out.write("visible");
    expect(out.seen).toEqual(["visible"]);
  });

  it("survives a second mute/restore cycle", () => {
    // Two prompts in a row — password, then confirm. The second cycle is the
    // one that was already broken by the first.
    const out = recorder();
    const r1 = muteEcho(out);
    out.write("password");
    r1();
    out.write("Confirm: ");
    const r2 = muteEcho(out);
    out.write("again");
    r2();
    out.write("done");
    expect(out.seen).toEqual(["Confirm: ", "done"]);
  });

  it("is idempotent on repeated restore", () => {
    const out = recorder();
    const restore = muteEcho(out);
    restore();
    restore();
    out.write("still visible");
    expect(out.seen).toEqual(["still visible"]);
  });
});
