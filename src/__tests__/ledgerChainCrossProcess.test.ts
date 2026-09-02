/**
 * ADR-0027 — two writers, one ledger, one chain.
 *
 * The integrity sequence and previous-hash are taken from the FILE under the
 * lock, not from anything a process remembers, and this is the test that can
 * only pass if that is true: two separate node processes append to the same
 * ledger through a barrier, and the result must verify with every `iseq`
 * present exactly once.
 *
 * Bundled with esbuild and spawned as plain `node x.mjs`, per the precedent in
 * `cronClaimCrossProcess.test.ts` — `--import tsx` cost 225 s of Windows CI.
 * Dead children are asserted as a joined string carrying their stderr, because
 * `expected [] to have length 2` is unreadable from a truncated CI log.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyLedgerChain } from "../ledgerChain.js";

const MODULE_UNDER_TEST = fileURLToPath(
  new URL("../ledgerChain.ts", import.meta.url),
);

let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(os.tmpdir(), "ledger-chain-xproc-"));
  await build({
    entryPoints: [MODULE_UNDER_TEST],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: join(root, "ledgerChain.mjs"),
    logLevel: "silent",
  });
  writeFileSync(
    join(root, "writer.mjs"),
    `
import { existsSync, writeFileSync } from "node:fs";
import { appendChained } from "./ledgerChain.mjs";
const [file, who, count, readyFile, goFile] = process.argv.slice(2);
writeFileSync(readyFile, "ready");
while (!existsSync(goFile)) await new Promise((r) => setTimeout(r, 1));
let n = 0;
for (let i = 0; i < Number(count); i++) {
  // A two-core Windows runner under contention can hold a lock well past the
  // 5 s production default; the property under test is the chain, not the wait.
  appendChained(file, { who, i }, { lockTimeoutMs: 60_000 });
  n++;
}
process.stdout.write("WROTE " + n + "\\n");
`,
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function race(n: number, perWriter: number): Promise<string[]> {
  const file = join(root, "ledger.jsonl");
  const goFile = join(root, "go");
  const readyFiles: string[] = [];
  let exited = 0;
  const children = Array.from({ length: n }, (_, i) => {
    const readyFile = join(root, `ready-${i}`);
    readyFiles.push(readyFile);
    return new Promise<string>((resolve) => {
      const child = spawn(
        process.execPath,
        [
          join(root, "writer.mjs"),
          file,
          `w${i}`,
          String(perWriter),
          readyFile,
          goFile,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => {
        out += String(d);
      });
      child.stderr.on("data", (d) => {
        err += String(d);
      });
      child.on("error", (e) => {
        exited++;
        resolve(`DIED(spawn) ${e.message}`);
      });
      child.on("close", (code) => {
        exited++;
        resolve(out.trim() || `DIED(code=${code}) ${err.trim().slice(0, 400)}`);
      });
    });
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (readyFiles.every((f) => existsSync(f))) break;
    if (exited === n) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  writeFileSync(goFile, "go");
  return Promise.all(children);
}

describe("two concurrent writers", () => {
  it("produce one unbroken chain with every iseq exactly once", async () => {
    const verdicts = await race(2, 15);
    expect(verdicts.join(" | ")).toBe("WROTE 15 | WROTE 15");
    const v = verifyLedgerChain(join(root, "ledger.jsonl"));
    expect(v.breaks).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.chainedRows).toBe(30);
    expect(v.lastIseq).toBe(30);
  }, 90_000);
});
