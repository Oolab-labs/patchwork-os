/**
 * Per-member credential storage — ADR-0020 Phase A.
 *
 * The property this file exists for: **the credential store fails CLOSED,
 * which is the opposite of the roster.**
 *
 * A missing `members.json` yields one implicit owner so a single-user machine
 * keeps working — "who may act on your own machine" defaults to the status
 * quo. A missing `credentials.json` yields nothing at all, so nobody
 * authenticates — "who are you" defaults to nobody. Getting that backwards
 * would mean an absent or corrupt file logging somebody in.
 *
 * Every degraded state — absent, unreadable, malformed JSON, wrong top-level
 * type, an entry that is not a scrypt record — must produce "no credential",
 * and none may throw: a thrown lookup is something a caller might catch and
 * treat as a pass.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CREDENTIALS_BASENAME,
  defaultCredentialsPath,
  loadCredentials,
} from "../credentialStore.js";
import { hashPassword } from "../credentials.js";

let dir = "";
let file = "";
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "cred-store-"));
  file = path.join(dir, CREDENTIALS_BASENAME);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("it fails closed", () => {
  it("an absent file authenticates nobody", () => {
    const s = loadCredentials(file);
    expect(s.credentialFor("m-alice")).toBeUndefined();
    expect(s.ids()).toEqual([]);
  });

  it("malformed JSON authenticates nobody, and does not throw", () => {
    writeFileSync(file, "{not json");
    const s = loadCredentials(file);
    expect(s.credentialFor("m-alice")).toBeUndefined();
  });

  it("a top-level array or scalar authenticates nobody", () => {
    for (const bad of ["[]", '"nope"', "42", "null"]) {
      writeFileSync(file, bad);
      expect(loadCredentials(file).credentialFor("m-alice")).toBeUndefined();
    }
  });

  it("an entry that is not a scrypt record is reported, not used", () => {
    // "your record is corrupt" and "no such user" are different facts, and an
    // operator debugging a failed login needs the first one said out loud.
    writeFileSync(
      file,
      JSON.stringify({ "m-alice": "hunter2", "m-bob": "bcrypt$x$y" }),
    );
    const s = loadCredentials(file);
    expect(s.credentialFor("m-alice")).toBeUndefined();
    expect(s.malformed.sort()).toEqual(["m-alice", "m-bob"]);
  });

  it("a valid record IS returned (control)", async () => {
    // Without this, every assertion above holds for a store that returns
    // undefined unconditionally — which would fail closed and also fail.
    const rec = await hashPassword("correct horse battery staple");
    writeFileSync(file, JSON.stringify({ "m-alice": rec }));
    const s = loadCredentials(file);
    expect(s.credentialFor("m-alice")).toBe(rec);
    expect(s.ids()).toEqual(["m-alice"]);
    expect(s.malformed).toEqual([]);
  });

  it("one corrupt entry does not deny the others", async () => {
    const rec = await hashPassword("pw");
    writeFileSync(file, JSON.stringify({ "m-alice": rec, "m-bob": "junk" }));
    const s = loadCredentials(file);
    expect(s.credentialFor("m-alice")).toBe(rec);
    expect(s.credentialFor("m-bob")).toBeUndefined();
  });
});

describe("file permissions", () => {
  // POSIX-only: NTFS reports 0o666 regardless of mode, so a mode assertion on
  // Windows is a check that cannot fail.
  it.skipIf(process.platform === "win32")(
    "tightens a group/world-readable file and says so",
    async () => {
      const rec = await hashPassword("pw");
      writeFileSync(file, JSON.stringify({ "m-alice": rec }));
      chmodSync(file, 0o644);

      const s = loadCredentials(file);
      expect(s.overlyPermissive).toBe(true);
      // Tightened, not merely complained about: an operator told at startup
      // has already been running that way for however long.
      expect(statSync(file).mode & 0o077).toBe(0);
      // And it still works — reporting a permissions problem must not lock
      // everyone out.
      expect(s.credentialFor("m-alice")).toBe(rec);
    },
  );

  it.skipIf(process.platform === "win32")(
    "a correctly-moded file is not flagged (control)",
    async () => {
      const rec = await hashPassword("pw");
      writeFileSync(file, JSON.stringify({ "m-alice": rec }));
      chmodSync(file, 0o600);
      expect(loadCredentials(file).overlyPermissive).toBe(false);
    },
  );
});

describe("location", () => {
  it("honours PATCHWORK_HOME", () => {
    const prev = process.env.PATCHWORK_HOME;
    process.env.PATCHWORK_HOME = dir;
    try {
      expect(defaultCredentialsPath()).toBe(file);
    } finally {
      if (prev === undefined) delete process.env.PATCHWORK_HOME;
      else process.env.PATCHWORK_HOME = prev;
    }
  });

  it("is a separate file from the roster", () => {
    // members.json is a reviewable document people share. The moment it
    // carries hashes, that is a leak by ordinary helpfulness.
    expect(CREDENTIALS_BASENAME).not.toBe("members.json");
  });
});

describe("the real CLI entry point", () => {
  // Drives `dist/index.js`. The in-process tests above import the module
  // directly, so they would pass just as happily if `patchwork members`
  // dispatched to nothing — which is the state every unwired feature is in.
  const DIST = path.resolve(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "dist",
    "index.js",
  );

  function run(args: string[], input?: string) {
    try {
      const out = execFileSync(process.execPath, [DIST, ...args], {
        encoding: "utf-8",
        env: { ...process.env, PATCHWORK_HOME: dir },
        ...(input !== undefined ? { input } : {}),
      });
      return { status: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return {
        status: e.status ?? -1,
        out: `${e.stdout ?? ""}${e.stderr ?? ""}`,
      };
    }
  }

  it.skipIf(!existsSync(DIST))("refuses a password from a pipe", () => {
    // A password arriving on stdin from a script is a password IN that
    // script — and in the shell history that ran it. argv is worse still:
    // it is visible in `ps` to every user on the box.
    const r = run(["members", "set-password", "m-alice"], "hunter2\n");
    expect(r.status).toBe(2);
    expect(r.out).toContain("interactive terminal");
    // Nothing was written on the refusal path.
    expect(existsSync(path.join(dir, CREDENTIALS_BASENAME))).toBe(false);
  });

  it.skipIf(!existsSync(DIST))(
    "reports a member with no password as unable to authenticate",
    () => {
      // The fail-soft roster hands out an implicit owner. Saying it "has" a
      // login it does not have is the same class of lie as defaulting an
      // actor to that owner.
      const r = run(["members", "list"]);
      expect(r.status).toBe(0);
      expect(r.out).toContain("NO password — cannot authenticate");
    },
  );
});
