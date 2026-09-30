/**
 * `patchwork doctor acceptance` against the REAL runtime.
 *
 * The mutation files beside this one (`doctorAcceptance.mutation-*.test.ts`)
 * break one guarded behaviour each and assert the matching check FAILS — a
 * check that passes against a broken runtime would be a symbol grep with
 * extra steps.
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatAcceptance, runAcceptance } from "../doctorAcceptance.js";

function listTree(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    out.push(p);
    if (statSync(p).isDirectory()) out.push(...listTree(p));
  }
  return out.sort();
}

let sentinel: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  sentinel = mkdtempSync(path.join(os.tmpdir(), "acceptance-sentinel-"));
  for (const k of ["HOME", "PATCHWORK_HOME"]) saved[k] = process.env[k];
  // Stand-ins for the operator's real homes, pre-populated like a live box.
  const realHome = path.join(sentinel, "real-home");
  const realPw = path.join(sentinel, "real-patchwork");
  mkdirSync(path.join(realPw, "config"), { recursive: true });
  mkdirSync(realHome, { recursive: true });
  mkdirSync(path.join(sentinel, "tmp"), { recursive: true });
  writeFileSync(path.join(realPw, "runs.jsonl"), "");
  writeFileSync(path.join(realPw, "approval_log.jsonl"), "");
  writeFileSync(path.join(realPw, "config.json"), '{"profile":"compat"}');
  process.env.HOME = realHome;
  process.env.PATCHWORK_HOME = realPw;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(sentinel, { recursive: true, force: true });
});

const opts = () => ({
  lockDir: path.join(sentinel, "no-locks"),
  buildTimeMs: Date.now(),
  tmpRoot: path.join(sentinel, "tmp"),
});

describe("doctor acceptance — real runtime", () => {
  it("passes all seven checks, leading with the denominator", async () => {
    const r = await runAcceptance(opts());
    const text = formatAcceptance(r);
    expect(text.split("\n")[0]).toBe("7 checks");
    expect(r.checks.map((c) => c.name)).toEqual([
      "identity",
      "effective-policy",
      "policy-refusal",
      "kill-switch",
      "uncertain-delivery",
      "replay",
      "run-lookup",
    ]);
    for (const c of r.checks) expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
    expect(r.ok).toBe(true);
    expect(text).toMatch(/commit not recorded/);
  }, 30_000);

  it("writes nothing outside its own sandbox, removes the sandbox, and restores env", async () => {
    const before = listTree(path.join(sentinel, "real-patchwork")).concat(
      listTree(path.join(sentinel, "real-home")),
    );
    const mtimes = before.map((p) => statSync(p).mtimeMs);
    await runAcceptance(opts());
    const after = listTree(path.join(sentinel, "real-patchwork")).concat(
      listTree(path.join(sentinel, "real-home")),
    );
    expect(after).toEqual(before);
    expect(after.map((p) => statSync(p).mtimeMs)).toEqual(mtimes);
    expect(readdirSync(path.join(sentinel, "tmp"))).toEqual([]);
    expect(process.env.HOME).toBe(path.join(sentinel, "real-home"));
    expect(process.env.PATCHWORK_HOME).toBe(
      path.join(sentinel, "real-patchwork"),
    );
  }, 30_000);

  it("identity fails when a live bridge predates the install", async () => {
    const lockDir = path.join(sentinel, "locks");
    mkdirSync(lockDir);
    writeFileSync(
      path.join(lockDir, "1.lock"),
      JSON.stringify({ pid: process.pid, startedAt: 1, isBridge: true }),
    );
    const r = await runAcceptance({ ...opts(), lockDir });
    const id = r.checks.find((c) => c.name === "identity");
    expect(id?.ok).toBe(false);
    expect(r.ok).toBe(false);
  }, 30_000);
});
