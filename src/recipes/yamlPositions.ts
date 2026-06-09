/**
 * YAML source-position resolver for lint diagnostics (Phase 1B).
 *
 * `validateRecipeDefinition` (validation.ts) emits `LintIssue` records
 * keyed by logical paths — "Step 3", "trigger.at", "name" — but operates
 * on a parsed JS object that has no source-position information. This
 * module re-parses the YAML text into a CST-aware Document and produces
 * a lookup table mapping logical-path strings to `{line, column}` pairs.
 *
 * `enrichIssuesWithPositions(yamlText, issues)` consults that map and
 * adds `line` / `column` fields to each issue. Issues whose path can't
 * be resolved are returned unchanged — the editor renders them at the
 * top of the file or just in the lint banner.
 *
 * Used by `lintRecipeContent` in recipesHttp.ts. The pure mapping is
 * exported separately so the Phase 1B follow-up (CodeMirror linter
 * extension in YamlEditor.tsx) can also key off it client-side without
 * re-running the validator.
 */

import { isMap, isPair, isScalar, isSeq, parseDocument } from "yaml";
import type { LintIssue } from "./validation.js";

interface Position {
  /** 1-indexed line in the source YAML. */
  line: number;
  /** 0-indexed column (character offset from the start of the line). */
  column: number;
}

/**
 * Map of "logical path" → source position. Keys take one of two shapes:
 *
 *   - `<key>` for top-level scalar/object fields (`name`, `description`,
 *     `trigger`, `steps`, ...).
 *   - `<key>.<sub...>` for nested mapping fields — e.g. `trigger.at`,
 *     `trigger.type`. Only the leaves we know the validator looks at are
 *     populated; deeper nesting is best-effort.
 *
 *   - `steps.<n>` for the Nth step (zero-indexed to match AJV
 *     `instancePath`). Maps to the line of the step's `id:` / `tool:` /
 *     `agent:` key.
 *
 *   - `steps.<n>.<field>` for step-level fields (`steps.0.prompt`).
 *
 * Construction is best-effort; a malformed YAML buffer produces an
 * empty map and falls through to top-of-file positions.
 */
export interface YamlPositionIndex {
  byPath: Map<string, Position>;
}

export function resolveYamlPositions(yamlText: string): YamlPositionIndex {
  const byPath = new Map<string, Position>();
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(yamlText, { keepSourceTokens: false });
  } catch {
    return { byPath };
  }

  const contents = doc.contents;
  if (!isMap(contents)) return { byPath };

  // Pre-compute a (offset → {line, column}) translator. `lineCounter`
  // would be more correct but adds a yaml-package option requirement —
  // do the math ourselves from a single pass over the source.
  //
  // column is 0-indexed: the first character on any line has column 0.
  // Previously `col` was initialised to 1, making all columns 1-indexed
  // (off by one vs. what downstream consumers expect). Fix: start at 0
  // and reset to 0 after each newline.
  const positionAt = (offset: number): Position => {
    let line = 1;
    let col = 0;
    for (let i = 0; i < offset && i < yamlText.length; i++) {
      if (yamlText.charCodeAt(i) === 0x0a) {
        line++;
        col = 0;
      } else {
        col++;
      }
    }
    return { line, column: col };
  };

  // Record positions for every top-level key.
  for (const pair of contents.items) {
    if (!isPair(pair)) continue;
    const key = pair.key;
    if (!isScalar(key) || typeof key.value !== "string") continue;
    const offset = key.range?.[0];
    if (typeof offset === "number") {
      byPath.set(key.value, positionAt(offset));
    }
    // Special-case the two most commonly-referenced root keys:
    // `steps` (sequence) and `trigger` (mapping). Walk one level deeper.
    if (key.value === "steps" && isSeq(pair.value)) {
      pair.value.items.forEach((stepNode, idx) => {
        if (!isMap(stepNode)) return;
        // Use the line of the FIRST key in the step mapping as the
        // step's source line — that's the line a user editing the
        // recipe sees as the "start" of step N.
        const firstKey = stepNode.items[0];
        if (
          !firstKey ||
          !isPair(firstKey) ||
          !isScalar(firstKey.key) ||
          typeof firstKey.key.value !== "string"
        ) {
          return;
        }
        const stepOffset = firstKey.key.range?.[0];
        if (typeof stepOffset !== "number") return;
        const stepPos = positionAt(stepOffset);
        byPath.set(`steps.${idx}`, stepPos);
        // Also index each step-level field for the more precise
        // schema-error cases (`steps.0.prompt`, `steps.0.tool`, ...).
        for (const subPair of stepNode.items) {
          if (!isPair(subPair)) continue;
          const subKey = subPair.key;
          if (!isScalar(subKey) || typeof subKey.value !== "string") continue;
          const subOffset = subKey.range?.[0];
          if (typeof subOffset !== "number") continue;
          byPath.set(`steps.${idx}.${subKey.value}`, positionAt(subOffset));
        }
      });
    }
    if (key.value === "trigger" && isMap(pair.value)) {
      for (const subPair of pair.value.items) {
        if (!isPair(subPair)) continue;
        const subKey = subPair.key;
        if (!isScalar(subKey) || typeof subKey.value !== "string") continue;
        const subOffset = subKey.range?.[0];
        if (typeof subOffset !== "number") continue;
        byPath.set(`trigger.${subKey.value}`, positionAt(subOffset));
      }
    }
  }

  return { byPath };
}

/**
 * Step-message regex: matches the "Step N:" prefix the hand-rolled
 * validator emits. N is 1-indexed in the message; we convert to
 * 0-indexed to match the AJV `instancePath` convention used in the
 * position index.
 */
const STEP_MSG_RE = /^Step (\d+):/;

/**
 * Resolve a LintIssue's logical position. Returns null when no match —
 * caller leaves the issue unannotated and the editor renders it without
 * a gutter marker.
 */
function resolveIssuePosition(
  issue: LintIssue,
  index: YamlPositionIndex,
): Position | null {
  // 1. Explicit `path` field set by Phase 1A `toSchemaLintIssue` —
  //    matches AJV `instancePath` shape (`steps.0.prompt`, `trigger.at`).
  if (issue.path && issue.path !== "recipe") {
    const exact = index.byPath.get(issue.path);
    if (exact) return exact;
    // Fall back to the parent: a deep schema error like `steps.0.params.0`
    // resolves to `steps.0` when the deeper position isn't known.
    const segments = issue.path.split(".");
    while (segments.length > 1) {
      segments.pop();
      const ancestor = index.byPath.get(segments.join("."));
      if (ancestor) return ancestor;
    }
  }
  // 2. "Step N:" prefix in the message — hand-rolled validator path.
  const stepMatch = STEP_MSG_RE.exec(issue.message);
  if (stepMatch?.[1]) {
    const n = Number.parseInt(stepMatch[1], 10) - 1;
    const stepPos = index.byPath.get(`steps.${n}`);
    if (stepPos) return stepPos;
  }
  // 3. "Missing or invalid 'X' field" — match the field name and look it
  //    up at the root.
  const missingFieldMatch = /'([a-zA-Z_][a-zA-Z0-9_]*)'/.exec(issue.message);
  if (missingFieldMatch?.[1]) {
    const fieldPos = index.byPath.get(missingFieldMatch[1]);
    if (fieldPos) return fieldPos;
  }
  return null;
}

/**
 * Return a copy of `issues` with `line` / `column` populated where the
 * logical path can be resolved against the source YAML. Issues whose
 * path doesn't match anything in the index are passed through unchanged
 * — callers must tolerate missing positions.
 */
export function enrichIssuesWithPositions(
  yamlText: string,
  issues: LintIssue[],
): LintIssue[] {
  if (issues.length === 0) return issues;
  const index = resolveYamlPositions(yamlText);
  if (index.byPath.size === 0) return issues;
  return issues.map((issue) => {
    // Preserve any line/column already set by the validator (future-
    // proofing — validators may grow source-aware emit paths).
    if (typeof issue.line === "number") return issue;
    const pos = resolveIssuePosition(issue, index);
    if (!pos) return issue;
    return { ...issue, line: pos.line, column: pos.column };
  });
}
