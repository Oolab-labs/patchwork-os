/**
 * The scheduler's clock dependency must be pinned EXACTLY, and the installed
 * copy must match the pin.
 *
 * ## What happened
 *
 * `package.json` declared `"node-cron": "^4.2.1"`. `package-lock.json` resolved
 * `4.2.1`, so CI (`npm ci`) tested `4.2.1` — while the globally installed
 * bridges actually serving requests were running **`4.6.0`**, measured on
 * 2026-08-19 by resolving the module from the installed package's own entry
 * point.
 *
 * The mechanism is not exotic and it is not a mistake anyone made: **`npm
 * install -g` does not honour a lockfile.** The lock governs a checkout; a
 * global install of a packed tarball re-resolves every range against the
 * registry at install time. So a caret on this dependency means the deployment
 * silently takes whatever the newest matching minor is, with no diff, no review
 * and no CI run — and the repo's own gates cannot see it, because they are
 * looking at the lockfile.
 *
 * That is not academic here. 4.6.0 changed when a task fires: it added a
 * `missedExecutionTolerance` defaulting to 1000 ms, so a heartbeat up to a
 * second late now RUNS its slot where 4.2.1 skipped it. The library that
 * decides when every governed action fires changed behaviour underneath a
 * governance runtime, between the code we test and the code we run.
 *
 * ## Why an exact pin rather than a gate
 *
 * Every other dependency here uses a caret, so this is a deliberate exception
 * and it is worth being precise about why: an exact spec is the ONLY thing that
 * closes the actual mechanism. A repo-side gate — including this test — cannot
 * observe a global install. The pin can, because a tarball carrying `4.6.0`
 * with no range operator has nothing left to re-resolve.
 *
 * So the pin is the fix and this test guards the pin. Stated plainly because
 * the tempting alternative is a gate that looks like it covers the deployment
 * and does not, which is the shape this repository keeps getting caught by.
 *
 * ## Why 4.6.0 rather than back to 4.2.1
 *
 * Pinning down would have CHANGED the behaviour of the running system on its
 * next install. 4.6.0 is what production has been executing; the pin makes the
 * repository agree with it, rather than issuing a silent downgrade to a
 * scheduler nobody has been running.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function repoPackageJson(): {
  dependencies: Record<string, string>;
} {
  const url = new URL("../../../package.json", import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf-8"));
}

describe("node-cron is pinned exactly", () => {
  it("declares a bare version, with no range operator", () => {
    const spec = repoPackageJson().dependencies["node-cron"];
    expect(spec).toBeDefined();
    // `^`, `~`, `>=`, `*`, `x`, a URL or a tag would all let a global install
    // resolve something CI never ran.
    expect(spec).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("the installed copy is the version that is pinned", () => {
    // Catches the in-repo half: a package.json edited without reinstalling, or
    // a lockfile that disagrees with the declared spec. It cannot see a global
    // install — see the header.
    const spec = repoPackageJson().dependencies["node-cron"];
    // Read the manifest off disk rather than `require("node-cron/package.json")`:
    // the package does not list `./package.json` in its `exports`, so the
    // resolver refuses it. A test that cannot load the thing it checks is not a
    // stricter test, it is an absent one.
    const installedManifest = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../node_modules/node-cron/package.json",
            import.meta.url,
          ),
        ),
        "utf-8",
      ),
    ) as { version: string };
    const installed = installedManifest.version;
    expect(installed).toBe(spec);
  });
});
