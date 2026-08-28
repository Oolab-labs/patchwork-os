#!/usr/bin/env node
/**
 * Does the PACKAGED, INSTALLED product work — not the source checkout?
 *
 * Every other check in this repository reads the working tree. `npm test`
 * imports from `src/`, the audit gates read tracked files, and the existing
 * smoke suites drive a bridge started from this directory. All of them pass on
 * a tarball that is missing a file, ships a broken `bin`, or installs and then
 * cannot run.
 *
 * This is the Consumer Contract Rule applied to the product itself:
 *
 *   Every pipeline that produces something another component or user consumes
 *   must include at least one final check where the REAL downstream consumer
 *   consumes that output.
 *
 * Here the producer is `npm pack` and the consumer is a person who ran
 * `npm install -g` and typed a command. So this packs, installs into a
 * throwaway prefix with a throwaway HOME, and drives the installed binary.
 *
 * ## Why the recipe round-trip is the centrepiece
 *
 * #1539 is the case this exists for. `recipe new` printed "✓ Created" over
 * YAML that did not parse, for months, because nothing between the template
 * and the filesystem ever read the result back. Unit tests passed. The
 * breakage surfaced far away — a recipe the bridge skipped at startup, and a
 * report that could not parse it.
 *
 * So the last step here feeds the scaffold's output to the real linter. A
 * producer test could not have caught it; only handing the artifact to its
 * actual consumer could.
 *
 * ## Deliberately NOT global
 *
 * Installs into a temp prefix, never `-g`. A verifier that clobbers the
 * operator's own install to prove the tarball is fine has broken the machine
 * it was reassuring.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = process.cwd();
let failures = 0;
let checks = 0;

function step(name, fn) {
  checks++;
  try {
    const detail = fn();
    process.stdout.write(`  ok    ${name}${detail ? ` — ${detail}` : ""}\n`);
  } catch (err) {
    failures++;
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`  FAIL  ${name}\n        ${msg.split("\n")[0]}\n`);
  }
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
    ...opts,
  });
}

process.stdout.write(
  "[fresh-install] packing, installing, and driving the INSTALLED product\n\n",
);

const work = mkdtempSync(join(tmpdir(), "pw-fresh-"));
const home = join(work, "home");
const prefix = join(work, "prefix");
const out = join(work, "out");
run("mkdir", ["-p", home, prefix, out]);

// The environment a new user has: no ~/.patchwork, no config, no bridge.
const env = {
  PATH: process.env.PATH,
  HOME: home,
  PATCHWORK_HOME: join(home, ".patchwork"),
};

let tarball;
try {
  step("npm pack produces a tarball", () => {
    const stdout = run(
      "npm",
      ["pack", "--silent", "--pack-destination", work],
      {
        cwd: repo,
      },
    );
    tarball = stdout.trim().split("\n").filter(Boolean).pop();
    if (!tarball) throw new Error("npm pack printed no filename");
    const full = join(work, tarball);
    if (!existsSync(full)) throw new Error(`tarball not at ${full}`);
    tarball = full;
    return tarball.split("/").pop();
  });

  step("it installs into a clean prefix", () => {
    run("npm", [
      "install",
      "--prefix",
      prefix,
      "--no-audit",
      "--no-fund",
      "--silent",
      tarball,
    ]);
    return prefix;
  });

  const bin = join(prefix, "node_modules", ".bin", "patchwork");

  step("the `patchwork` bin exists and is executable", () => {
    if (!existsSync(bin)) throw new Error(`no bin at ${bin}`);
    run(bin, ["--help"], { env });
    return bin.replace(work, "<tmp>");
  });

  // The consumer contract. `recipe new` is the producer; `recipe lint` is the
  // real downstream consumer. #1539 shipped because these were never joined.
  const recipePath = join(out, "fresh-probe.yaml");
  step("recipe new writes a scaffold", () => {
    run(bin, ["recipe", "new", "fresh-probe", "--out", out], { env });
    if (!existsSync(recipePath)) throw new Error(`no recipe at ${recipePath}`);
    return "fresh-probe.yaml";
  });

  step("THE REAL LINTER accepts what the scaffold wrote", () => {
    // The whole point. A producer-only test passes against a scaffold that
    // emits unparseable YAML while printing "Created".
    const stdout = run(bin, ["recipe", "lint", recipePath], { env });
    if (!/Valid recipe/.test(stdout)) {
      throw new Error(`linter did not accept the scaffold: ${stdout.trim()}`);
    }
    return "parses and lints";
  });

  step("the scaffold is parseable YAML by an independent reader", () => {
    // Not the linter's opinion — an independent parse, so a linter that grew
    // lenient cannot hide a malformed file.
    const yaml = readFileSync(recipePath, "utf-8");
    const line = yaml.split("\n").find((l) => l.startsWith("description:"));
    if (!line) throw new Error("no description line");
    // `description: Recipe: name` is the #1539 shape: a bare colon-space in an
    // unquoted scalar. Assert the emitted form is quoted or colon-free.
    const value = line.slice("description:".length).trim();
    if (/:\s/.test(value) && !/^["']/.test(value)) {
      throw new Error(`unquoted scalar containing ": " — ${line}`);
    }
    return "no bare colon in an unquoted scalar";
  });

  step("tool registration works from the installed artifact", () => {
    // `tools list --json`, not `tools --json` — the bare form prints usage and
    // exits 0. The first version of this check used the bare form, "failed",
    // and looked exactly like a packaging defect. Worth recording: a verifier
    // that is wrong in the failing direction burns real time chasing a bug in
    // the product that is actually a bug in the check.
    const stdout = run(bin, ["tools", "list", "--json"], { env });
    const parsed = JSON.parse(stdout);
    const n = Array.isArray(parsed)
      ? parsed.length
      : Object.values(parsed).reduce(
          (acc, v) => acc + (Array.isArray(v) ? v.length : 0),
          0,
        );
    if (!n || n < 50) throw new Error(`only ${n} tools registered`);
    return `${n} tools`;
  });

  step("it runs with NO pre-existing ~/.patchwork", () => {
    // A first-run user has no config, no recipes, no ledgers. Commands that
    // assume those exist fail here and nowhere else.
    const stdout = run(bin, ["privacy", "destinations"], { env });
    if (!/INERT|where your prompts may go/.test(stdout)) {
      throw new Error(
        `unexpected first-run output: ${stdout.trim().slice(0, 120)}`,
      );
    }
    return "first-run clean";
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}

process.stdout.write(
  `\n[fresh-install] ${checks - failures}/${checks} checks passed\n`,
);
if (failures > 0) {
  process.stdout.write(
    "  The SOURCE tree can be green while this fails — that is the point.\n",
  );
  process.exit(1);
}
