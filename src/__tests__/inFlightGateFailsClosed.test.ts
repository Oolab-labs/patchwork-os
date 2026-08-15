/**
 * `audit-in-flight` must not report a clean ledger because the API was down.
 *
 * `prState` shells out to `gh pr list` and used to `catch { return null }`.
 * null is ALSO how "this branch has no PR yet" is spelled, and that state is
 * deliberately treated as fine — it is what a branch looks like before its PR
 * exists. So a network failure and a legitimately-new branch were the same
 * value, and any stale entry went green whenever `gh` could not reach the API.
 *
 * Observed, not theorised: two runs seconds apart on the same tree, one
 * failing correctly on a merged entry and one printing
 *
 *     [in-flight] OK — every Active entry is genuinely in flight.
 *
 * The pre-fix script, driven under the stub below with a MERGED entry sitting
 * in Active, printed exactly that line and exited 0.
 *
 * The stub makes the credential probe succeed and the PR query fail, which is
 * the only interesting case: a probe failure is already handled (it exits 1
 * under CI), and a total `gh` outage never reaches `prState` at all.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..", "..");
const SCRIPT = path.join(root, "scripts", "audit-in-flight.mjs");

const dir = mkdtempSync(path.join(os.tmpdir(), "in-flight-gate-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A ledger with one Active entry naming a branch. Content beyond that is
 *  irrelevant: under the stub every PR query fails regardless. */
const LEDGER = path.join(dir, "ledger.md");
writeFileSync(
  LEDGER,
  [
    "## Active",
    "",
    "- `feat/some-branch` — a thing.",
    "",
    "## Recently closed",
    "",
  ].join("\n"),
);

/** `gh` where the repo probe works and `pr list` does not. */
function stubGh(): string {
  const bin = path.join(dir, "bin");
  execFileSync("mkdir", ["-p", bin]);
  const stub = path.join(bin, "gh");
  writeFileSync(
    stub,
    "#!/bin/sh\ncase \"$1\" in\n  api) echo 'owner/repo'; exit 0 ;;\n  pr) echo 'error connecting to api.github.com' >&2; exit 1 ;;\nesac\nexit 1\n",
  );
  chmodSync(stub, 0o755);
  return bin;
}

function run(env: NodeJS.ProcessEnv): { status: number; out: string } {
  try {
    return {
      status: 0,
      out: execFileSync(process.execPath, [SCRIPT, "--ledger", LEDGER], {
        cwd: root,
        encoding: "utf8",
        env,
      }),
    };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? -1,
      out: `${e.stdout ?? ""}${e.stderr ?? ""}`,
    };
  }
}

describe("a gh failure is not a clean ledger", () => {
  // POSIX-only: the seam is a `#!/bin/sh` stub earlier on PATH. Same
  // convention as the CVE gate's subprocess test.
  it.skipIf(process.platform === "win32")(
    "exits 2 when the PR query never answers",
    () => {
      const bin = stubGh();
      const { status, out } = run({
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
      });

      // 2, not 1: "we could not check" is a different fact from "we checked
      // and found drift", and neither may be spelled the same as success.
      expect(status).toBe(2);
      expect(out).toContain("could not query PR state");
      // The exact line it must never print in this state.
      expect(out).not.toContain("every Active entry is genuinely in flight");
    },
  );

  it.skipIf(process.platform === "win32")("retries before giving up", () => {
    // A read-only query, so retrying has no side effects — and failing the
    // build on one bad second would just be a new flake source.
    const bin = stubGh();
    const { out } = run({ ...process.env, PATH: `${bin}:${process.env.PATH}` });
    expect(out.match(/gh query failed — retrying/g)?.length).toBe(2);
  });
});
