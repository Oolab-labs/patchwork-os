/**
 * `$PATCHWORK_HOME/.env` holds `DASHBOARD_SESSION_SECRET`. Forge one and you
 * can mint a session naming any member, which is the entire ADR-0020
 * attribution scheme — so the file's permissions are a governance property,
 * not housekeeping.
 *
 * `credentialStore` already tightens its own file on read for exactly this
 * reason. Nothing did it here, and the file was found mode 644 on the
 * reference machine on 2026-08-26.
 *
 * The trap that hid it: `patchworkInit` DOES pass `{ mode: 0o600 }`, so the
 * code looks correct. `writeFileSync` applies `mode` only when CREATING a
 * file — on an existing one Node ignores it silently, so a `.env` that ever
 * became loose stayed loose however many times init ran.
 */

import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSessionSecretFromHome } from "../sessionSecretFile.js";

const SECRET = "a".repeat(64);
let home: string;
let envFile: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "pw-envperm-"));
  envFile = path.join(home, ".env");
  writeFileSync(envFile, `DASHBOARD_SESSION_SECRET=${SECRET}\n`, {
    mode: 0o600,
  });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const mode = () => statSync(envFile).mode & 0o777;

// NTFS reports 0o666 whatever chmod does, so these assertions are meaningless
// there and the production check skips win32 for the same reason.
describe.skipIf(process.platform === "win32")(
  "the session-secret file is tightened on read",
  () => {
    it("tightens a group/world-readable file to 0600", () => {
      chmodSync(envFile, 0o644);
      expect(mode()).toBe(0o644);
      const warnings: string[] = [];
      const secret = readSessionSecretFromHome(home, (m) => warnings.push(m));
      expect(mode()).toBe(0o600);
      // Still returns the secret: refusing to read it would turn a permissions
      // problem into an attribution outage, which is the worse failure.
      expect(secret).toBe(SECRET);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("Tightened to 0600");
    });

    it("REPORTS, not just fixes — silence would leave the operator unaware", () => {
      chmodSync(envFile, 0o604);
      const warnings: string[] = [];
      readSessionSecretFromHome(home, (m) => warnings.push(m));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/readable by group or others/);
      expect(warnings[0]).toMatch(/rotate the secret/);
    });

    it("says nothing when the file is already 0600", () => {
      const warnings: string[] = [];
      expect(readSessionSecretFromHome(home, (m) => warnings.push(m))).toBe(
        SECRET,
      );
      expect(warnings).toEqual([]);
      expect(mode()).toBe(0o600);
    });

    it("group-execute-only still counts as loose", () => {
      chmodSync(envFile, 0o610);
      const warnings: string[] = [];
      readSessionSecretFromHome(home, (m) => warnings.push(m));
      expect(mode()).toBe(0o600);
      expect(warnings).toHaveLength(1);
    });

    it("works with no reporter passed — the existing call shape", () => {
      chmodSync(envFile, 0o644);
      expect(readSessionSecretFromHome(home)).toBe(SECRET);
      expect(mode()).toBe(0o600);
    });

    it("an absent file is not a warning", () => {
      rmSync(envFile);
      const warnings: string[] = [];
      expect(
        readSessionSecretFromHome(home, (m) => warnings.push(m)),
      ).toBeUndefined();
      expect(warnings).toEqual([]);
    });
  },
);
