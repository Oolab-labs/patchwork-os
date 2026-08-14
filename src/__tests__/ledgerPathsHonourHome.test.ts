import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveApprovalLogDir } from "../approvalPersistence.js";
import { resolveOutcomeLogDir } from "../workers/outcomeStore.js";

const original = process.env.PATCHWORK_HOME;
afterEach(() => {
  if (original === undefined) delete process.env.PATCHWORK_HOME;
  else process.env.PATCHWORK_HOME = original;
});

describe("evidence ledgers resolve their home through patchworkHome() (#1265)", () => {
  it("pins a RELATIVE override to an absolute path", () => {
    // The property gained by routing through the helper rather than reading
    // the env var by hand. The old form returned the raw string, so the
    // directory re-pointed whenever the process changed working directory —
    // and this process has a CwdChanged hook, so that is a live hazard.
    //
    // An audit ledger that silently moves mid-session is the worst version of
    // this bug: nothing errors, and the evidence simply lands somewhere the
    // operator is not looking.
    process.env.PATCHWORK_HOME = "relative-home";

    for (const resolve of [resolveApprovalLogDir, resolveOutcomeLogDir]) {
      const dir = resolve();
      expect(path.isAbsolute(dir), `${dir} must be absolute`).toBe(true);
      expect(dir).toBe(path.resolve("relative-home"));
    }
  });

  it("still lets an explicit override win, unresolved", () => {
    // Callers pass a tmp dir (tests) or the shadow's `patchworkDir`. That path
    // is already what the caller means and must not be reinterpreted.
    process.env.PATCHWORK_HOME = "/env/home";
    expect(resolveApprovalLogDir("/explicit")).toBe("/explicit");
    expect(resolveOutcomeLogDir("/explicit")).toBe("/explicit");
  });

  it("falls back to the legacy home when the override is unset or blank", () => {
    // Blank must not resolve to the process cwd — that would scatter ledgers
    // into whatever directory the bridge happened to start in.
    for (const value of [undefined, "", "   "]) {
      if (value === undefined) delete process.env.PATCHWORK_HOME;
      else process.env.PATCHWORK_HOME = value;
      const dir = resolveOutcomeLogDir();
      expect(path.isAbsolute(dir)).toBe(true);
      expect(dir.endsWith(".patchwork")).toBe(true);
    }
  });
});
