/**
 * Wiring guards for ADR-0020 separation of duties.
 *
 * The behaviour is tested end to end elsewhere (approvalSeparationOfDuties,
 * recipeRunStarter, workerGateApprovalNotifies). What those cannot see is the
 * bridge's startup wiring, which no unit test drives:
 *
 *   - `requireNamedApprover` must be decided AFTER `setActiveProfile(profile)`.
 *     Earlier in `start()` the active profile is still the compat default, so
 *     a decision placed there reads "not governed" on every install and the
 *     rule never switches on — with every test green. That happened while this
 *     was being built.
 *   - The server must hand the flag to the approve route, and its session
 *     verifier to the run routes, or both rules are inert.
 *
 * Anchored on the CALLS, not on declarations, because a declaration never
 * moves and would pass against a broken call site.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = (f: string) => readFileSync(path.join(__dirname, "..", f), "utf8");

describe("separation-of-duties wiring", () => {
  it("bridge decides requireNamedApprover after the profile is published", () => {
    const bridge = src("bridge.ts");
    const published = bridge.indexOf("setActiveProfile(profile);");
    const decided = bridge.indexOf(
      "this.server.requireNamedApprover = memberLoginsExist(",
    );
    expect(published).toBeGreaterThan(-1);
    expect(decided).toBeGreaterThan(published);
    // And only one decision site, so a stale copy cannot linger above it.
    expect(bridge.split("this.server.requireNamedApprover =").length - 1).toBe(
      1,
    );
  });

  it("server passes the flag to the approve route and the verifier to the run routes", () => {
    const server = src("server.ts");
    expect(server).toMatch(
      /requireNamedApprover:\s*this\.requireNamedApprover/,
    );
    expect(server).toMatch(/resolveRunStarter:\s*this\.resolveApprover/);
  });
});
