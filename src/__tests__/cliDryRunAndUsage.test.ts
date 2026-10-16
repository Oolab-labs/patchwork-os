/**
 * CLI argument handling that the in-process tests cannot see.
 *
 * Audit 2026-10-15:
 *  - H5: `recipe rollback <name> --attempt <id> --ledger-dir <d> --dry-run`
 *    performed a REAL rollback. `--dry-run` was parsed but read only on the
 *    `--run` branch; the function-level tests call the command functions
 *    directly and never went through `src/index.ts`.
 *  - `policy explain` given only flags (`--json`, `--start manual`) crashed
 *    with "Cannot read properties of undefined" — the bare-verb check looked
 *    at args[1], which was the flag, so no recipe reached the explainer.
 *
 * Drives the built `dist/index.js`, skipped when it has not been built.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileRollbackLog } from "../recipes/fileRollback.js";
import { deriveScopeKey } from "../recipes/idempotencyKey.js";

const DIST = path.resolve(import.meta.dirname, "..", "..", "dist", "index.js");

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "pw-cli-dryrun-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function cli(args: string[]) {
  try {
    const out = execFileSync(process.execPath, [DIST, ...args], {
      encoding: "utf-8",
      env: { ...process.env, PATCHWORK_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
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

describe("recipe rollback --attempt --dry-run", () => {
  it.skipIf(!existsSync(DIST))(
    "lists what it WOULD restore and changes nothing",
    () => {
      const ledger = path.join(home, "ledger");
      mkdirSync(ledger, { recursive: true });
      const file = path.join(home, "note.md");
      writeFileSync(file, "original");
      const log = new FileRollbackLog({
        dir: ledger,
        scopeKey: deriveScopeKey("probe", "attempt-1"),
      });
      expect(log.capturePreImage(file).persisted).toBe(true);
      writeFileSync(file, "written-by-run");

      const r = cli([
        "recipe",
        "rollback",
        "probe",
        "--attempt",
        "attempt-1",
        "--ledger-dir",
        ledger,
        "--dry-run",
      ]);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain("nothing changed");
      expect(r.out).toContain(file);
      // The point: a dry run must not have restored the file.
      expect(readFileSync(file, "utf-8")).toBe("written-by-run");
    },
  );
});

describe("policy explain with flags but no recipe", () => {
  for (const flags of [["--json"], ["--start", "manual"]]) {
    it.skipIf(!existsSync(DIST))(
      `prints usage, not a crash: ${flags.join(" ")}`,
      () => {
        const r = cli(["policy", "explain", ...flags]);
        expect(r.status).toBe(2);
        expect(r.out).toContain("Usage: patchwork policy explain");
        expect(r.out).not.toContain("Cannot read properties");
      },
    );
  }
});
