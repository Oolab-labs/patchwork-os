/**
 * Which agent steps carry no `data_policy`, and what actually feeds them?
 *
 * ADR-0021 is fail-soft: a step with no `data_policy` is classified `internal`
 * and the boundary lets it through. That is the correct default — it is what
 * keeps the boundary inert on upgrade — but it means an undeclared step is
 * invisible in exactly the way a declared one is not. Measured 2026-08-26 on
 * the reference install: **132 of 214** privacy-shadow observations carried
 * `labelSource: "assumed"`, and installed recipes declared `data_policy` on
 * **20 of 87** agent steps against **22 of 22** in the shipped templates.
 *
 * ## Why this reports the FEEDING TOOLS and not just the step
 *
 * A classification describes what the step HANDLES, "including whatever its
 * tools return" — that rule is in CLAUDE.md and it is the whole difficulty. A
 * prompt whose text mentions nothing sensitive can still be handed a mailbox by
 * the step above it, which is precisely why `morning-brief` declares `personal`
 * while its prompt only says how to go and fetch things.
 *
 * So a report that listed undeclared steps would tell an operator WHERE to look
 * and nothing about WHAT to write. This resolves each `{{ref}}` in the prompt
 * back to the step that produced it and names that step's tool, which is the
 * evidence the classification actually rests on.
 *
 * ## It suggests nothing
 *
 * Deliberately no recommended classification, not even a conservative one.
 * Guessing a label and presenting it as a starting point is how an unexamined
 * claim ends up declared — and a declared-but-wrong label is strictly worse
 * than an assumed one, because it stops looking like a gap. The operator reads
 * the tools and decides. Same reason `privacy suggest` emits `privacy.shadow`
 * and never the enforcing `privacy.destinations` key.
 *
 * Read-only. Output is OPERATOR DATA — it names real installed recipes — so it
 * is quoted as a measurement and never pasted into an issue or a fixture.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/** A `{{ref}}` in a prompt, resolved back to whatever produced it. */
export interface FeedingOutput {
  /** The `into:` key referenced by the prompt. */
  ref: string;
  /** Tool that produced it, or undefined when nothing in this recipe does. */
  tool?: string;
  /** True when the producing step is itself an agent. */
  fromAgent?: boolean;
}

export interface UndeclaredStep {
  recipe: string;
  /** Step id, or a positional label when the step declares none. */
  stepId: string;
  /** Resolved `{{ref}}`s, so the reader can classify from what flows in. */
  feeds: FeedingOutput[];
  /** Refs the prompt uses that no step in this recipe produces. */
  unresolvedRefs: string[];
}

export interface UndeclaredReport {
  /** Recipes examined — the denominator. */
  recipesScanned: number;
  /** Every agent step found, declared or not. The other denominator. */
  agentSteps: number;
  declared: number;
  undeclared: UndeclaredStep[];
  /** Recipes that could not be parsed. Reported, never silently dropped. */
  unreadable: string[];
}

interface RawStep {
  id?: unknown;
  into?: unknown;
  tool?: unknown;
  agent?: { prompt?: unknown; into?: unknown; data_policy?: unknown } | unknown;
  data_policy?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `{{a.b}}` / `{{ a }}` → the root key. Filters template helpers and literals. */
export function refsIn(prompt: string): string[] {
  const out = new Set<string>();
  for (const m of prompt.matchAll(/\{\{\s*([A-Za-z_][\w.-]*)/g)) {
    const root = (m[1] as string).split(".")[0] as string;
    out.add(root);
  }
  return [...out];
}

/**
 * Analyse one already-parsed recipe. Takes parsed YAML rather than a path so
 * the caller owns file access and this stays trivially testable.
 */
export function undeclaredInRecipe(
  recipeName: string,
  parsed: unknown,
): { agentSteps: number; declared: number; steps: UndeclaredStep[] } {
  if (!isRecord(parsed) || !Array.isArray(parsed.steps)) {
    return { agentSteps: 0, declared: 0, steps: [] };
  }
  const raw = parsed.steps as RawStep[];

  // into-key -> producing tool, built first so a prompt can be resolved against
  // steps that appear before OR after it. Order is the runner's problem, not
  // this report's.
  const producers = new Map<string, { tool?: string; fromAgent: boolean }>();
  for (const s of raw) {
    if (!isRecord(s)) continue;
    const agent = isRecord(s.agent) ? s.agent : undefined;
    const into =
      typeof s.into === "string"
        ? s.into
        : agent && typeof agent.into === "string"
          ? agent.into
          : undefined;
    if (!into) continue;
    producers.set(into, {
      ...(typeof s.tool === "string" ? { tool: s.tool } : {}),
      fromAgent: agent !== undefined,
    });
  }

  let agentSteps = 0;
  let declared = 0;
  const steps: UndeclaredStep[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    if (!isRecord(s)) continue;
    const agent = isRecord(s.agent) ? s.agent : undefined;
    if (!agent) continue;
    agentSteps++;
    // `data_policy` sits on the agent block in shipped templates; accept it at
    // step level too rather than reporting a false positive over a spelling.
    if (agent.data_policy !== undefined || s.data_policy !== undefined) {
      declared++;
      continue;
    }
    const prompt = typeof agent.prompt === "string" ? agent.prompt : "";
    const feeds: FeedingOutput[] = [];
    const unresolved: string[] = [];
    for (const ref of refsIn(prompt)) {
      const p = producers.get(ref);
      if (p) {
        feeds.push({
          ref,
          ...(p.tool ? { tool: p.tool } : {}),
          ...(p.fromAgent ? { fromAgent: true } : {}),
        });
      } else {
        unresolved.push(ref);
      }
    }
    steps.push({
      recipe: recipeName,
      stepId:
        typeof s.id === "string"
          ? s.id
          : typeof s.into === "string"
            ? s.into
            : `step_${i}`,
      feeds,
      unresolvedRefs: unresolved,
    });
  }
  return { agentSteps, declared, steps };
}

export function formatUndeclared(r: UndeclaredReport): string {
  const L: string[] = [];
  L.push("[privacy] agent steps with no data_policy");
  // Denominator first, always: "67 undeclared" reads as an alarm, "67 of 87"
  // is the fact.
  L.push(
    `  ${r.undeclared.length} of ${r.agentSteps} agent step(s) across ${r.recipesScanned} recipe(s) declare none`,
  );
  if (r.unreadable.length > 0) {
    L.push(`  ${r.unreadable.length} recipe(s) could not be parsed`);
  }
  L.push("");
  if (r.undeclared.length === 0) {
    L.push(
      r.agentSteps === 0
        ? "  no agent steps found — nothing to classify"
        : "  ✓ every agent step declares a data_policy",
    );
    L.push("");
    return `${L.join("\n")}\n`;
  }
  let current = "";
  for (const s of r.undeclared) {
    if (s.recipe !== current) {
      current = s.recipe;
      L.push(`  ${current}`);
    }
    const fed =
      s.feeds.length === 0
        ? "no step output flows in"
        : s.feeds
            .map(
              (f) =>
                `${f.ref}${f.tool ? ` <- ${f.tool}` : f.fromAgent ? " <- agent" : ""}`,
            )
            .join(", ");
    L.push(`      ${s.stepId}: ${fed}`);
    if (s.unresolvedRefs.length > 0) {
      L.push(`        (unresolved refs: ${s.unresolvedRefs.join(", ")})`);
    }
  }
  L.push("");
  L.push(
    "  Classify by what the step HANDLES, including whatever its tools return —",
  );
  L.push(
    "  a prompt that mentions nothing sensitive can still be handed a mailbox by",
  );
  L.push(
    "  the step above it. No classification is suggested here on purpose: a",
  );
  L.push(
    "  declared-but-wrong label is worse than an assumed one, because it stops",
  );
  L.push("  looking like a gap.");
  L.push("");
  return `${L.join("\n")}\n`;
}

/**
 * Scan a directory of recipe YAML and aggregate `undeclaredInRecipe` across it.
 *
 * Extracted from the `privacy undeclared` handler so `patchwork sweep` reads the
 * same number the verb prints. Two implementations of "how many agent steps
 * declare a data_policy" would drift, and the drift is silent: the sweep would
 * report a delta of zero while the verb reported a regression, or vice versa,
 * and neither would look wrong.
 *
 * Throws only when the directory cannot be read. A recipe that will not parse is
 * REPORTED in `unreadable`, never skipped silently — a file present and ignored
 * is the failure mode this whole family of verbs exists to surface.
 */
export function scanRecipeDir(dir: string): UndeclaredReport {
  const entries = readdirSync(dir).sort();
  let recipesScanned = 0;
  let agentSteps = 0;
  let declared = 0;
  const undeclared: UndeclaredStep[] = [];
  const unreadable: string[] = [];
  for (const f of entries) {
    if (!/\.ya?ml$/i.test(f)) continue;
    recipesScanned++;
    let parsed: unknown;
    try {
      parsed = parseYaml(readFileSync(path.join(dir, f), "utf-8"));
    } catch {
      unreadable.push(f);
      continue;
    }
    const declaredName = (parsed as { name?: unknown } | undefined)?.name;
    const name = typeof declaredName === "string" ? declaredName : f;
    const r = undeclaredInRecipe(name, parsed);
    agentSteps += r.agentSteps;
    declared += r.declared;
    undeclared.push(...r.steps);
  }
  return { recipesScanned, agentSteps, declared, undeclared, unreadable };
}
