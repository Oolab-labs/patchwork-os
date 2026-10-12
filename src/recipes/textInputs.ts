/**
 * `type: text` recipe inputs — prose a caller hands a run.
 *
 * Ordinary run inputs are short tokens: `validateRecipeVars` allow-lists
 * letters, digits, spaces and `- . : + @ ,`. That rule is defence in depth for
 * template-driven path traversal (the real guard is the post-render path jail
 * in `resolveRecipePath.ts`), and it also makes it impossible to hand a recipe
 * any real prose. A `text` input admits prose, and in exchange it is held to
 * rules a token never needed:
 *
 *   - **Content positions only.** A text value may be rendered into an agent
 *     prompt, a file body or a message body — never into a path, URL, ref,
 *     channel, recipient, id or any other parameter. The content fields are an
 *     explicit ALLOW-list; a field not named below is not content. Checked by
 *     both runners before a step renders anything, and by `recipe lint` (so
 *     save-time validation refuses the recipe too). The path jail stays as the
 *     backstop.
 *   - **Data, not instructions, in a prompt** — the governed untrusted envelope
 *     (`untrustedContent.ts`), labelled `input:<name>`.
 *   - **Never copied into a ledger** — while a run holds a text value it is
 *     registered with the value-redaction layer (`secretValues.ts`), which
 *     every persistence sink already passes through, and is replaced there by
 *     its length and a hash prefix.
 *
 * This module holds the rules; the runners and the routes call it.
 */

import { createHash } from "node:crypto";
import { registerTextInputValue } from "../governance/secretValues.js";
import {
  type DeclaredTriggerInput,
  declaredTriggerInputs,
} from "./triggerVars.js";

/** A text value's length limit when the recipe declares no `maxLength`. */
export const TEXT_INPUT_DEFAULT_MAX_LENGTH = 16_384;
/** The limit no `maxLength` can raise. */
export const TEXT_INPUT_HARD_MAX_LENGTH = 65_536;

/** Error code for a text input referenced outside a content field. */
export const TEXT_INPUT_IN_IDENTIFIER = "text_input_in_identifier";

/**
 * Control characters a text value may not carry: C0 except `\t` `\n` `\r`,
 * DEL, and the C1 block. NUL is the case that matters most (it truncates
 * strings in C-backed sinks); the rest have no place in prose.
 */
const TEXT_CONTROL_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;

/** The effective length limit for a declared text input. */
export function textInputLimit(maxLength?: number): number {
  const declared =
    typeof maxLength === "number" &&
    Number.isInteger(maxLength) &&
    maxLength > 0
      ? maxLength
      : TEXT_INPUT_DEFAULT_MAX_LENGTH;
  return Math.min(declared, TEXT_INPUT_HARD_MAX_LENGTH);
}

/**
 * Why `value` is not an acceptable text value, or null when it is. Length is
 * counted in UTF-16 code units (`String.length`), the unit every limit in this
 * codebase uses.
 */
export function textInputValueError(
  value: string,
  maxLength?: number,
): string | null {
  const limit = textInputLimit(maxLength);
  if (value.length === 0) return "must be a non-empty string";
  if (value.length > limit) {
    return `must be at most ${limit} characters (got ${value.length})`;
  }
  if (TEXT_CONTROL_RE.test(value)) {
    return "contains a control character (a text input may contain any Unicode text plus line breaks and tabs, but no NUL or other control characters)";
  }
  return null;
}

/** The declared text inputs of a recipe, by name. */
export function textInputsOf(
  recipe: unknown,
): Map<string, DeclaredTriggerInput> {
  const out = new Map<string, DeclaredTriggerInput>();
  for (const input of declaredTriggerInputs(recipe)) {
    if (input.type === "text") out.set(input.name, input);
  }
  return out;
}

/** Just the names — what the render guard and the envelope need. */
export function textInputNamesOf(recipe: unknown): Set<string> {
  return new Set(textInputsOf(recipe).keys());
}

// ---------------------------------------------------------------------------
// Content positions
// ---------------------------------------------------------------------------

/** Fields of an `agent:` block that are prompt text. */
const AGENT_CONTENT_FIELDS: ReadonlySet<string> = new Set(["prompt"]);

/**
 * Per tool, the params that are message or file BODIES. Anything not listed —
 * including every param of a tool not listed — is treated as an identifier.
 * Extending this list is a decision that a field's value is only ever shown
 * or stored as content, never used to address something.
 */
const TOOL_CONTENT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "file.write": ["content"],
  "file.append": ["content"],
  "http.post": ["body"],
  "slack.post_message": ["text", "blocks"],
  "slack.postMessage": ["text", "blocks"],
  "discord.send_message": ["content"],
  "telegram.send_message": ["text"],
  "sendgrid.send_email": ["text", "html"],
  "resend.send_email": ["text", "html"],
  "twilio.send_sms": ["body"],
};

/** True when `field` of a step running `tool` is a content position. */
export function isTextContentField(
  tool: string | undefined,
  field: string,
): boolean {
  // Object.hasOwn: a step's `tool` is author input, and bracket access would
  // walk the prototype (`tool: constructor`).
  if (tool === undefined || !Object.hasOwn(TOOL_CONTENT_FIELDS, tool)) {
    return false;
  }
  return TOOL_CONTENT_FIELDS[tool]?.includes(field) === true;
}

/** Where a text input was found outside a content field. */
export interface TextInputPlacement {
  input: string;
  /** Dotted path of the field inside the step, e.g. `path`, `agent.model`. */
  field: string;
}

const TEMPLATE_EXPR_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

/**
 * The text inputs a template string references. Both runners' forms are
 * recognised in both runners — `{{name}}` / `{{name.x}}` (flat) and
 * `{{env.name}}` (chained) — because over-reporting here can only refuse, and
 * a template that does not resolve in one runner is still a statement of
 * intent about where the value goes.
 */
export function textInputsReferenced(
  template: string,
  names: ReadonlySet<string>,
): string[] {
  if (names.size === 0 || !template.includes("{{")) return [];
  const found: string[] = [];
  for (const m of template.matchAll(TEMPLATE_EXPR_RE)) {
    const parts = (m[1] ?? "").trim().replace(/^\{+/, "").split(".");
    const root = parts[0]?.trim() ?? "";
    const candidate = root === "env" ? (parts[1]?.trim() ?? "") : root;
    if (names.has(candidate) && !found.includes(candidate)) {
      found.push(candidate);
    }
  }
  return found;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function collect(
  value: unknown,
  field: string,
  names: ReadonlySet<string>,
  out: TextInputPlacement[],
): void {
  if (typeof value === "string") {
    for (const input of textInputsReferenced(value, names)) {
      out.push({ input, field });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      collect(v, `${field}.${i}`, names, out);
    });
    return;
  }
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      collect(v, `${field}.${k}`, names, out);
    }
  }
}

/** Decides whether `field` of a step running `tool` is a content position. */
export type ContentFieldPredicate = (
  tool: string | undefined,
  field: string,
) => boolean;

function scanStep(
  step: Record<string, unknown>,
  prefix: string,
  names: ReadonlySet<string>,
  isContent: ContentFieldPredicate,
  out: TextInputPlacement[],
): void {
  const tool = typeof step.tool === "string" ? step.tool : undefined;
  for (const [key, value] of Object.entries(step)) {
    if (key === "agent" && isPlainObject(value)) {
      for (const [ak, av] of Object.entries(value)) {
        if (AGENT_CONTENT_FIELDS.has(ak)) continue;
        collect(av, `${prefix}agent.${ak}`, names, out);
      }
      continue;
    }
    // A fan_out body is a step of its own, judged by its own tool.
    if (key === "do" && tool === "fan_out" && isPlainObject(value)) {
      scanStep(value, `${prefix}do.`, names, isContent, out);
      continue;
    }
    if (isContent(tool, key)) continue;
    collect(value, `${prefix}${key}`, names, out);
  }
}

/**
 * Every place a step references one of `names` outside a content field, where
 * `isContent` says which tool params are content (an agent's `prompt` always
 * is). Static over the step as written — the same answer before and after
 * rendering, because rendering is single-pass substitution and cannot
 * introduce a reference that was not in the template. Shared by `type: text`
 * and `type: file` inputs (`fileInputs.ts`), which differ only in the list.
 */
export function findInputsOutsideContent(
  step: unknown,
  names: ReadonlySet<string>,
  isContent: ContentFieldPredicate,
): TextInputPlacement[] {
  if (names.size === 0 || !isPlainObject(step)) return [];
  const out: TextInputPlacement[] = [];
  scanStep(step, "", names, isContent, out);
  return out;
}

/** Every place a step references a text input outside a content field. */
export function findTextInputsInIdentifiers(
  step: unknown,
  names: ReadonlySet<string>,
): TextInputPlacement[] {
  return findInputsOutsideContent(step, names, isTextContentField);
}

/** The step-failure / lint message for one placement. */
export function textInputInIdentifierMessage(
  p: TextInputPlacement,
  stepLabel: string,
): string {
  return (
    `${TEXT_INPUT_IN_IDENTIFIER}: text input "${p.input}" is referenced in ` +
    `"${p.field}" of ${stepLabel}. A text input may only be rendered into ` +
    "content fields (an agent prompt, a file's content, a message body) — " +
    "never into a path, URL, ref, channel, recipient or id."
  );
}

// ---------------------------------------------------------------------------
// Ledger form
// ---------------------------------------------------------------------------

/**
 * What a ledger records in place of a text value: its length and a short hash
 * prefix — enough to tell two runs' inputs apart, never enough to read them.
 */
export function textInputLedgerMarker(value: string): string {
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  return `[text: ${value.length} chars, sha256:${digest.slice(0, 12)}…]`;
}

/**
 * Register a run's text input values with the value-redaction layer for the
 * duration of the run; returns the release function. Every persistence sink
 * (run log capture, approval queue, activity log, decision traces, logger,
 * orchestrator task file) already passes through that layer, so this one call
 * covers all of them — and a new sink that redacts secrets redacts these too.
 */
export function holdTextInputValues(
  names: ReadonlySet<string>,
  values: Record<string, unknown> | undefined,
): () => void {
  if (names.size === 0 || !values) return () => {};
  const releases: Array<() => void> = [];
  for (const name of names) {
    const v = Object.hasOwn(values, name) ? values[name] : undefined;
    if (typeof v !== "string" || v.length === 0) continue;
    releases.push(registerTextInputValue(v, textInputLedgerMarker(v)));
  }
  return () => {
    for (const r of releases) r();
  };
}
