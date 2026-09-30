/** Mutation: uncertainty no longer blocks a retry ⇒ `uncertain-delivery` must FAIL. */
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("../../recipes/uncertainOutcome.js", async (orig) => ({
  ...(await orig<typeof import("../../recipes/uncertainOutcome.js")>()),
  isUncertainOutcome: () => false,
  mustNotRetryWrite: () => false,
}));

import { runAcceptance } from "../doctorAcceptance.js";

it("uncertain-delivery FAILS when an uncertain write may be resent", async () => {
  const r = await runAcceptance({
    lockDir: path.join(os.tmpdir(), "no-such-lock-dir"),
    buildTimeMs: Date.now(),
  });
  const c = r.checks.find((x) => x.name === "uncertain-delivery");
  expect(c?.ok).toBe(false);
  expect(c?.detail).toMatch(/received [2-9]/);
  expect(r.ok).toBe(false);
}, 30_000);
