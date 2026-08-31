/**
 * `patchwork workers list` / `workers validate` — read-only.
 *
 * `workers` shipped with `shadow` and `backtest` only, so a worker reached a
 * running bridge by hand-copying a file and there was no way to ask whether it
 * had landed correctly. Three failure modes are silent, and all three end the
 * same way — the autonomy gate does not govern that worker at all:
 *
 *  1. **A manifest that does not parse is SKIPPED.** `loadWorkersFromDir` is
 *     fail-soft by design (one bad file must not blind the whole dial), and it
 *     logs only when the caller passes a logger. The bridge does not pass one
 *     on the resolution path.
 *  2. **A `recipe:` naming something not installed** binds the worker to
 *     nothing.
 *  3. **Two manifests claiming the same recipe** resolve to `undefined` —
 *     deliberately, since guessing would apply the wrong worker's policy — so
 *     BOTH are ignored rather than one winning.
 *
 * In every case `resolveWorkerIdForRecipe` returns undefined, the caller falls
 * back to the tier-based approval fn, and the worker ramp never runs. The worker
 * gate is composed as a FLOOR over the tier fn — it can only ADD approvals — so
 * losing it means the recipe is governed LESS, not more. Most sharply, a
 * manifest's ADR-0017 `forbids` list, whose whole point is that no trust and no
 * approval can unlock the action, becomes inert without a word.
 *
 * Manifest drift has the opposite problem: `detectWorkerManifestDrift` is wired,
 * but only into the bridge's STARTUP report. A real signal that appears once, in
 * a log, at the moment nobody is watching. This makes it something an operator
 * can ask for.
 *
 * Read-only and deliberately no `install` verb: a package format has to answer
 * the third-copy problem (`templates/workers/` and `~/.patchwork/workers/`
 * already diverge, which is why `manifestDrift` exists at all), and that is a
 * design decision, not a missing function.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { patchworkPath } from "../patchworkHome.js";
import { parseForbidRules } from "./forbidPolicy.js";
import {
  detectWorkerManifestDrift,
  formatWorkerManifestDrift,
} from "./manifestDrift.js";
import { parseWorker, type WorkerManifest } from "./worker.js";
import {
  probeWorkerRecipes,
  type RecipeHealthProbe,
  summariseRecipeHealth,
} from "./workerRecipeHealth.js";

const MANIFEST_RE = /\.worker\.ya?ml$/i;

export interface LoadedWorker {
  file: string;
  worker: WorkerManifest;
}

export interface BrokenWorker {
  file: string;
  reason: string;
}

export interface WorkersScan {
  dir: string;
  loaded: LoadedWorker[];
  /** Files that exist and do NOT load. The population `loadWorkersFromDir` drops. */
  broken: BrokenWorker[];
}

/**
 * Like `loadWorkersFromDir`, but KEEPS what it could not parse instead of
 * discarding it. That difference is the entire point: the loader's job is to
 * keep the bridge running, this one's job is to tell an operator what the
 * bridge silently ignored.
 */
export function scanWorkers(dir: string): WorkersScan {
  const loaded: LoadedWorker[] = [];
  const broken: BrokenWorker[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return { dir, loaded, broken };
  }
  for (const file of entries.sort()) {
    if (!MANIFEST_RE.test(file)) continue;
    try {
      loaded.push({
        file,
        worker: parseWorker(
          parseYaml(readFileSync(path.join(dir, file), "utf-8")),
        ),
      });
    } catch (err) {
      broken.push({
        file,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { dir, loaded, broken };
}

/**
 * Declared recipe NAME → the file that declares it, for `dir`.
 *
 * A recipe's `name:` and its filename are allowed to differ, and a worker's
 * `recipe:` names the former. Keeping the path is what lets the recipe-health
 * probe open the right file instead of guessing `<name>.yaml` and reporting a
 * recipe it simply could not find as one it could not check.
 */
export function installedRecipePaths(dir: string): Map<string, string> {
  const byName = new Map<string, string>();
  if (!existsSync(dir)) return byName;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return byName;
  }
  for (const f of entries.sort()) {
    if (!/\.ya?ml$/i.test(f)) continue;
    const full = path.join(dir, f);
    try {
      const parsed = parseYaml(readFileSync(full, "utf-8")) as
        | { name?: unknown }
        | undefined;
      // First declarant wins, and entries are sorted, so the mapping is stable
      // rather than directory-order dependent.
      if (typeof parsed?.name === "string" && !byName.has(parsed.name)) {
        byName.set(parsed.name, full);
      }
    } catch {
      // An unreadable recipe is the recipe subsystem's problem to report, not
      // this one's. Skipping it can only make the dangling check MORE likely to
      // fire, never less — it cannot hide a real finding.
    }
  }
  return byName;
}

/** Recipe names installed in `dir`, for the dangling-reference check. */
export function installedRecipeNames(dir: string): Set<string> {
  // One walk, one parse, two readers. Two implementations of "what is
  // installed" drift, and the drift shows up as a dangling-recipe error next to
  // a recipe-health finding that says the same file is fine.
  return new Set(installedRecipePaths(dir).keys());
}

export interface WorkersFinding {
  level: "error" | "warning" | "info";
  code: string;
  message: string;
}

export interface ValidateResult {
  findings: WorkersFinding[];
  healthy: boolean;
  counts: { loaded: number; broken: number; recipesProbed?: number };
  /**
   * Denominator line for the recipe-health pass. ABSENT when no probe ran —
   * which is not the same statement as "every bound recipe is fine", and is
   * printed as its own line rather than folded into silence.
   */
  recipeHealth?: string;
}

export function validateWorkers(opts: {
  workersDir: string;
  recipesDir: string;
  templatesDir?: string;
  /**
   * `recipes.disabled` from the patchwork config. Passed IN rather than read
   * here so this stays a pure function of its inputs — a validator that reads
   * the operator's config behind the caller's back cannot be tested against a
   * state the machine is not in.
   */
  disabledRecipes?: ReadonlyArray<string>;
}): ValidateResult {
  const scan = scanWorkers(opts.workersDir);
  const findings: WorkersFinding[] = [];

  for (const b of scan.broken) {
    findings.push({
      level: "error",
      code: "unparseable-manifest",
      message:
        `${b.file} does not parse, so the bridge SKIPS it — no worker owns its ` +
        `recipe and the autonomy gate (including any forbids) never runs for it. ${b.reason}`,
    });
  }

  const recipes = installedRecipeNames(opts.recipesDir);
  const disabled = new Set(opts.disabledRecipes ?? []);
  const claims = new Map<string, string[]>();
  for (const { worker } of scan.loaded) {
    if (!worker.recipe) {
      findings.push({
        level: "warning",
        code: "no-recipe",
        message: `${worker.id} declares no \`recipe:\`, so nothing binds it to a run. Its owns/forbids govern nothing.`,
      });
      continue;
    }
    if (recipes.size > 0 && !recipes.has(worker.recipe)) {
      findings.push({
        level: "error",
        code: "dangling-recipe",
        message: `${worker.id} names recipe "${worker.recipe}", which is not installed. The worker governs nothing.`,
      });
    }
    if (disabled.has(worker.recipe)) {
      // The completest way a perfect binding governs nothing: the scheduler,
      // the event-trigger programs and the HTTP route all consult this list, so
      // the recipe fires from no trigger at all. A WARNING and not an error —
      // disabling a recipe is a deliberate act, and failing the check on an
      // intended state is how a gate gets ignored. What is worth saying is the
      // pairing: the worker is still installed and still claims to govern this.
      findings.push({
        level: "warning",
        code: "disabled-recipe",
        message:
          `${worker.id} is bound to recipe "${worker.recipe}", which is DISABLED — ` +
          "no trigger fires it, so the worker never runs. Re-enable the recipe " +
          "or uninstall the worker; leaving both is a manifest that governs nothing.",
      });
    }
    claims.set(worker.recipe, [
      ...(claims.get(worker.recipe) ?? []),
      worker.id,
    ]);
  }

  for (const { worker } of scan.loaded) {
    // `forbids` is held raw on the manifest and parsed at point of use, because
    // a deny-list that silently loses a rule fails OPEN: the banned action
    // degrades to merely gated, and a human can then approve it. That is the
    // one direction ADR-0017's terminal `forbid` must never degrade in, so an
    // unparseable entry is an ERROR here rather than a warning.
    const parsed = parseForbidRules(worker.forbids);
    if (parsed.invalid.length > 0) {
      findings.push({
        level: "error",
        code: "unparseable-forbid-rule",
        message:
          `${worker.id} has ${parsed.invalid.length} unparseable forbids entr${parsed.invalid.length === 1 ? "y" : "ies"} ` +
          `(index ${parsed.invalid.join(", ")}). A dropped deny-rule fails OPEN — the action becomes merely gated, ` +
          "which a human can approve.",
      });
    }
  }

  for (const [recipe, ids] of claims) {
    if (ids.length > 1) {
      findings.push({
        level: "error",
        code: "ambiguous-recipe",
        message:
          `recipe "${recipe}" is claimed by ${ids.length} workers (${ids.join(", ")}). ` +
          "Resolution refuses to guess, so ALL of them are ignored — not one of them wins.",
      });
    }
  }

  if (opts.templatesDir) {
    const drift = detectWorkerManifestDrift({
      templatesDir: opts.templatesDir,
      liveDir: opts.workersDir,
    });
    for (const line of formatWorkerManifestDrift(drift)) {
      findings.push({
        level: "warning",
        code: "manifest-drift",
        message: line,
      });
    }
  }

  return {
    findings,
    healthy: !findings.some((f) => f.level === "error"),
    counts: { loaded: scan.loaded.length, broken: scan.broken.length },
  };
}

/**
 * The default probe: `recipe doctor`'s static half, against the file that
 * actually declares the name a worker is bound to.
 *
 * Dynamically imported. `commands/recipe.ts` pulls in the planner, the tool
 * registry and the fixture loader, and `workers list` has no business paying
 * for any of that.
 */
export function makeRecipeDoctorProbe(recipesDir: string): RecipeHealthProbe {
  const byName = installedRecipePaths(recipesDir);
  return async (recipeName: string) => {
    const { runPreflight } = await import("../commands/recipe.js");
    // Resolve through the declared name when we can. Falling back to the bare
    // name lets `runPreflight` find a bundled template the live dir does not
    // carry, rather than reporting it uncheckable.
    const ref = byName.get(recipeName) ?? recipeName;
    const result = await runPreflight(ref, {});
    return {
      ok: result.ok,
      issues: result.issues.map((i) => ({
        level: i.level,
        code: i.code,
        message: i.message,
      })),
    };
  };
}

/**
 * `validateWorkers` plus the question it never asked: can the recipe on the
 * other end of a successful binding actually run?
 *
 * Separate from `validateWorkers` (which stays sync and dependency-free) rather
 * than folded into it: the probe is async and drags in the recipe planner, and
 * every existing caller of the structural check keeps working untouched.
 */
export async function validateWorkersWithRecipeHealth(opts: {
  workersDir: string;
  recipesDir: string;
  templatesDir?: string;
  disabledRecipes?: ReadonlyArray<string>;
  /** Override for tests; defaults to `recipe doctor`'s static half. */
  probe?: RecipeHealthProbe;
}): Promise<ValidateResult> {
  const base = validateWorkers(opts);
  const scan = scanWorkers(opts.workersDir);
  const bindings = scan.loaded.map(({ worker }) => ({
    id: worker.id,
    recipe: worker.recipe,
  }));
  const probed = new Set(
    bindings.map((b) => b.recipe).filter((r): r is string => !!r),
  ).size;
  const probe = opts.probe ?? makeRecipeDoctorProbe(opts.recipesDir);
  const health = await probeWorkerRecipes(bindings, { probe });
  const findings = [...base.findings, ...health];
  return {
    findings,
    healthy: !findings.some((f) => f.level === "error"),
    counts: { ...base.counts, recipesProbed: probed },
    recipeHealth: summariseRecipeHealth(health, { probed }),
  };
}

export function formatWorkersList(scan: WorkersScan): string {
  const out: string[] = [];
  out.push(`Workers in ${scan.dir}`);
  out.push("─".repeat(40));
  if (scan.loaded.length === 0 && scan.broken.length === 0) {
    out.push("  (none installed)");
    out.push("");
    return `${out.join("\n")}\n`;
  }
  for (const { worker } of scan.loaded) {
    out.push(
      `  ${worker.id}  —  ${worker.name}\n` +
        `      recipe: ${worker.recipe ?? "(none)"}   ceiling: L${worker.autonomyCeiling}   ` +
        `owns: ${worker.owns.length}   forbids: ${parseForbidRules(worker.forbids).rules.length}`,
    );
  }
  // Broken files are listed WITH the healthy ones, not hidden behind a flag.
  // The whole failure mode is that they are invisible.
  for (const b of scan.broken) {
    out.push(
      `  ✗ ${b.file}  —  NOT LOADED (the bridge ignores it): ${b.reason}`,
    );
  }
  out.push("");
  out.push(
    `  ${scan.loaded.length} loaded${scan.broken.length > 0 ? `, ${scan.broken.length} IGNORED` : ""}`,
  );
  out.push("");
  return `${out.join("\n")}\n`;
}

export function formatWorkersValidate(result: ValidateResult): string {
  const out: string[] = [];
  out.push("Worker manifest validation");
  out.push("─".repeat(40));
  // Lead with the denominator, like `privacy receipts` and `halts`: "0 problems"
  // over an empty directory is not the same statement as "0 problems" over eight
  // manifests, and reporting them identically is how an empty install reads as a
  // clean one.
  out.push(
    `  ${result.counts.loaded} manifest(s) load, ${result.counts.broken} ignored`,
  );
  // A second denominator, for the second question. "No problems" over manifests
  // that were checked and recipes that were NOT is the exact reading this pass
  // was added to end.
  if (result.recipeHealth) out.push(`  ${result.recipeHealth}`);
  if (result.findings.length === 0) {
    out.push("");
    out.push(
      result.counts.loaded === 0
        ? "  nothing to check — no worker manifests are installed"
        : "  ✓ no problems found",
    );
    out.push("");
    return `${out.join("\n")}\n`;
  }
  out.push("");
  for (const f of result.findings) {
    const mark = f.level === "error" ? "✗" : f.level === "warning" ? "⚠" : "·";
    out.push(`  ${mark} [${f.code}] ${f.message}`);
  }
  out.push("");
  return `${out.join("\n")}\n`;
}

export function defaultWorkersDir(): string {
  return patchworkPath("workers");
}
export function defaultRecipesDir(): string {
  return patchworkPath("recipes");
}
