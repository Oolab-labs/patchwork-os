/**
 * ADR-0020 attribution is shipped and, on most launch paths, UNREACHABLE.
 *
 * Measured on the live machine 2026-08-24: all three running bridges lacked
 * `DASHBOARD_SESSION_SECRET` in their environment, while the secret sat on disk
 * in `~/.patchwork/.env` exactly where `patchwork init` wrote it. So every
 * approval those bridges recorded was unattributed despite correct setup, and
 * "attribution is off" was indistinguishable from "nobody authenticated".
 *
 * The cause is the dotenv loader in `src/index.ts`: its candidates are built
 * from `import.meta.url`, so it reads `<install-dir>/.env` — which
 * `npm run install:global` destroys on every reinstall — and never
 * `$PATCHWORK_HOME/.env`. `start-all.sh --no-tmux` works only because that
 * script sources the file into the shell first; launchd, the tmux path and a
 * bare `patchwork start` do not.
 *
 * ── Why the fix is a Node-side reader plus an injected fallback ─────────────
 *
 * `dashboardSession.ts` is imported by the DASHBOARD's Edge middleware
 * (`dashboard/src/lib/session.ts:43`), where `node:` imports are unavailable
 * and a build failure locks every user out of the dashboard. So the file read
 * cannot live there. It lives in a Node-only module and is injected.
 *
 * And it is injected rather than written into `process.env`, because
 * `claudeDriver.ts:295` spawns agents with `{ ...process.env }` — putting the
 * secret there would hand it to every agent subprocess to solve a problem that
 * needs one value in one process.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __setSessionSecretFallback,
  signSession,
  verifySession,
} from "../dashboardSession.js";
import { readSessionSecretFromHome } from "../sessionSecretFile.js";

let home = "";
const SECRET = "0123456789abcdef0123456789abcdef";

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "pw-secret-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  __setSessionSecretFallback(undefined);
});

function writeEnv(body: string): void {
  writeFileSync(path.join(home, ".env"), body, "utf-8");
}

describe("readSessionSecretFromHome", () => {
  it("finds the key patchwork init writes", () => {
    writeEnv(
      `DASHBOARD_PASSWORD=hunter2\nDASHBOARD_SESSION_SECRET=${SECRET}\n`,
    );
    expect(readSessionSecretFromHome(home)).toBe(SECRET);
  });

  it("returns undefined when the file has no such key", () => {
    writeEnv("DASHBOARD_PASSWORD=hunter2\n");
    expect(readSessionSecretFromHome(home)).toBeUndefined();
  });

  it("returns undefined when there is no file at all", () => {
    expect(readSessionSecretFromHome(home)).toBeUndefined();
  });

  it("ignores a commented-out key rather than reading it as a value", () => {
    writeEnv(`#DASHBOARD_SESSION_SECRET=${SECRET}\n`);
    expect(readSessionSecretFromHome(home)).toBeUndefined();
  });

  it("strips surrounding quotes, as the loader in index.ts does", () => {
    writeEnv(`DASHBOARD_SESSION_SECRET="${SECRET}"\n`);
    expect(readSessionSecretFromHome(home)).toBe(SECRET);
  });

  it("reads ONLY the session secret, never the neighbouring passwords", () => {
    // The whole reason this is a single-key reader rather than a second dotenv
    // load: agent subprocesses inherit the bridge's env wholesale, so a broad
    // load would hand them DASHBOARD_PASSWORD to deliver one unrelated value.
    writeEnv(
      `DASHBOARD_PASSWORD=hunter2\nPASSWORD=hunter3\nDASHBOARD_SESSION_SECRET=${SECRET}\n`,
    );
    readSessionSecretFromHome(home);
    expect(process.env.DASHBOARD_PASSWORD).toBeUndefined();
    expect(process.env.PASSWORD).toBeUndefined();
  });

  it("does not put the secret into process.env either", () => {
    writeEnv(`DASHBOARD_SESSION_SECRET=${SECRET}\n`);
    expect(readSessionSecretFromHome(home)).toBe(SECRET);
    // Injected, not exported — `claudeDriver.ts` spawns with `{ ...process.env }`.
    expect(process.env.DASHBOARD_SESSION_SECRET).toBeUndefined();
  });
});

describe("the injected fallback makes a session verifiable", () => {
  it("verifies a signed session when only the fallback is set", async () => {
    // This is the whole bug: with the env var absent, the secret was
    // unreachable and every session was unverifiable, so no approval could
    // ever name a member.
    expect(process.env.DASHBOARD_SESSION_SECRET).toBeUndefined();
    __setSessionSecretFallback(SECRET);

    const cookie = await signSession({ memberId: "m-1" });
    const res = await verifySession(cookie);

    expect(res.valid).toBe(true);
    expect(res.memberId).toBe("m-1");
  });

  it("still refuses everything when no secret is reachable at all", async () => {
    __setSessionSecretFallback(SECRET);
    const cookie = await signSession({ memberId: "m-1" });

    __setSessionSecretFallback(undefined);
    // No secret means no verification means no actor — and an absent actor
    // already means "nobody recorded this". Failing closed here is correct.
    expect((await verifySession(cookie)).valid).toBe(false);
  });

  it("lets the environment variable win over the fallback", async () => {
    // Precedence matters: an operator who exports the variable is making a
    // deliberate choice, and a file on disk must not silently override it.
    __setSessionSecretFallback("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    process.env.DASHBOARD_SESSION_SECRET = SECRET;
    try {
      const cookie = await signSession({ memberId: "m-2" });
      __setSessionSecretFallback("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
      const res = await verifySession(cookie);
      expect(res.valid).toBe(true);
      expect(res.memberId).toBe("m-2");
    } finally {
      process.env.DASHBOARD_SESSION_SECRET = undefined;
      delete process.env.DASHBOARD_SESSION_SECRET;
    }
  });
});
