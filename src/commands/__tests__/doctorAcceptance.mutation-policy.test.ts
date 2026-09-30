/** Mutation: the policy matrix allows everything ⇒ `policy-refusal` must FAIL. */
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("../../recipes/toolPolicyCheck.js", () => ({
  enforceToolPolicy: () => {},
}));

import { runAcceptance } from "../doctorAcceptance.js";

it("policy-refusal FAILS when the policy check is stubbed to allow", async () => {
  const r = await runAcceptance({
    lockDir: path.join(os.tmpdir(), "no-such-lock-dir"),
    buildTimeMs: Date.now(),
  });
  const c = r.checks.find((x) => x.name === "policy-refusal");
  expect(c?.ok).toBe(false);
  expect(c?.detail).toMatch(/WRITTEN/);
  expect(r.ok).toBe(false);
}, 30_000);
