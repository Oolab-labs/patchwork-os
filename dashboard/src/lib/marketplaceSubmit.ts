/**
 * Utilities for the marketplace "Submit a recipe" flow.
 *
 * Approach: GitHub's anonymous web-contribution flow. Opening a prefilled
 * `https://github.com/<owner>/<repo>/new/<branch>?filename=...&value=...`
 * URL takes the user straight to GitHub's create-file form with the
 * filename and content already populated. If they don't have push access,
 * GitHub auto-forks. After commit, GitHub surfaces a "Propose new file"
 * button that opens a PR back to the upstream registry.
 *
 * Two files are needed per submission (recipe.yaml + recipe.json), so the
 * flow is two-step: submit the YAML first, then add the manifest on the
 * same fork branch.
 *
 * No backend, no OAuth, no upload endpoint required — works for any
 * user with a GitHub account.
 */

import { parse as parseYaml } from "yaml";
import type { ApprovalBehavior, RiskLevel } from "./registry";

export const REGISTRY_OWNER = "patchworkos";
export const REGISTRY_REPO = "recipes";
export const REGISTRY_BRANCH = "main";

/**
 * Starter recipe YAML shown in the submit form on first visit. Kept here
 * (not in the page file) so the schema/header drift can be regression-
 * tested against the rest of the registry contract.
 */
export const STARTER_RECIPE_YAML = `# yaml-language-server: $schema=https://raw.githubusercontent.com/patchworkos/recipes/main/schema/recipe.v1.json
apiVersion: patchwork.sh/v1
name: my-recipe
description: One-line description of what this recipe does.
trigger:
  type: manual
steps:
  - id: step-1
    agent:
      prompt: |
        Describe what Claude should do in this step.
      into: step_output
`;

/**
 * Preset YAMLs the user can switch between in the submit form. Each
 * preset is a complete recipe shape that lints clean and gives the
 * author one less thing to remember (the trigger block syntax for each
 * type is fiddly to get right from memory).
 *
 * The `manual` preset is the same as STARTER_RECIPE_YAML — kept linked
 * here so a future schema change ripples to both.
 */
export interface RecipePreset {
  id: "manual" | "scheduled" | "webhook";
  label: string;
  description: string;
  yaml: string;
}

const SCHEDULED_RECIPE_YAML = `# yaml-language-server: $schema=https://raw.githubusercontent.com/patchworkos/recipes/main/schema/recipe.v1.json
apiVersion: patchwork.sh/v1
name: my-recipe
description: Runs on a cron schedule.
trigger:
  type: cron
  at: "0 9 * * 1-5"  # weekdays at 9am — see https://crontab.guru
steps:
  - id: step-1
    agent:
      prompt: |
        Describe what Claude should do on each run.
      into: step_output
`;

const WEBHOOK_RECIPE_YAML = `# yaml-language-server: $schema=https://raw.githubusercontent.com/patchworkos/recipes/main/schema/recipe.v1.json
apiVersion: patchwork.sh/v1
name: my-recipe
description: Triggered by an HTTP POST to the bridge.
trigger:
  type: webhook
  path: /hooks/my-recipe
steps:
  - id: step-1
    agent:
      prompt: |
        Use the {{payload}} placeholder to access the request body.
      into: step_output
`;

export const RECIPE_PRESETS: readonly RecipePreset[] = [
  {
    id: "manual",
    label: "Manual",
    description: "Run on demand from the dashboard or CLI.",
    yaml: STARTER_RECIPE_YAML,
  },
  {
    id: "scheduled",
    label: "Scheduled (cron)",
    description: "Fires on a cron schedule. Edit the cron string in the YAML.",
    yaml: SCHEDULED_RECIPE_YAML,
  },
  {
    id: "webhook",
    label: "Webhook",
    description: "Triggered by an HTTP POST. Recipe receives {{payload}}.",
    yaml: WEBHOOK_RECIPE_YAML,
  },
];

/**
 * Storage key used to auto-save the in-progress form draft.
 *
 * v1 was `sessionStorage` (tab-scoped — closing the tab wiped the
 * draft with no warning). v2 (Wave 2 fix) is `localStorage` with an
 * embedded `savedAt` timestamp + a 7-day TTL: drafts older than that
 * are auto-cleared on read so a stale unfinished submission can't
 * lurk forever, and a banner announces "Restored draft from X days
 * ago — discard?" when the restored draft is more than an hour old.
 *
 * v1 entries are left in place; a v1 → v2 migration would risk
 * surfacing a stale draft as "fresh" without the user knowing, so
 * intentionally a clean break.
 */
export const SUBMIT_DRAFT_STORAGE_KEY = "patchwork.marketplaceSubmit.draft.v2";
export const SUBMIT_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface SubmissionFormData {
  /** Unscoped kebab-case slug (e.g. "my-recipe"). */
  slug: string;
  /** GitHub-style handle without the leading "@" (e.g. "myhandle"). */
  author: string;
  /** Semver string (e.g. "1.0.0"). */
  version: string;
  description: string;
  tags: string[];
  connectors: string[];
  /** SPDX-style license id (e.g. "MIT"). */
  license: string;
  /** Optional homepage URL. */
  homepage?: string;
  riskLevel: RiskLevel;
  networkAccess: boolean;
  fileAccess: boolean;
  approvalBehavior: ApprovalBehavior;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// GitHub username rules: 1-39 chars, alphanumerics + hyphen, can't start/end with hyphen
const AUTHOR_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?$/;
// Used for individual tag and connector entries — kebab/dot/underscore-friendly,
// rejects whitespace, slashes, and the kinds of strings registry consumers might
// later render as filter chips.
const TAG_OR_CONNECTOR_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/** Normalize a free-form name to a kebab-case slug. */
export function normalizeSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** Strip a leading "@" if the user pasted "@handle". */
export function normalizeAuthor(input: string): string {
  return input.trim().replace(/^@+/, "");
}

export interface ValidationIssue {
  field: keyof SubmissionFormData | "yaml";
  message: string;
  /**
   * Severity of the issue. Absent is treated as "error" (blocking) by
   * every existing call site — kept optional so the long-standing
   * form-field issues don't all have to be touched. Trust-consistency
   * heuristics (S2) emit "warning": surfaced to the author but never
   * blocking, since the heuristics are deliberately conservative and
   * can false-positive.
   */
  level?: "error" | "warning";
}

/**
 * Extract the `name:` value from a recipe YAML doc.
 *
 * Top-level only — won't be fooled by nested `name:` keys under `steps:`
 * or `vars:`. Returns null if the field is absent or YAML-quoted in a
 * shape we don't unwrap (rare in practice for recipes).
 */
export function extractYamlName(yaml: string): string | null {
  // Trailing YAML comments (`name: foo # primary`) are valid and common
  // in production recipes. The previous regex required `\s*$` directly
  // after the value, so any `# comment` caused a silent null return
  // (downstream treated as "no name in YAML" — misleading error).
  // Now allow optional `[\s]*#.*` after the value, before EOL.
  const match =
    /^name:\s*("([^"]+)"|'([^']+)'|([^\s#]+))\s*(?:#.*)?$/m.exec(yaml);
  if (!match) return null;
  return match[2] ?? match[3] ?? match[4] ?? null;
}

/**
 * Validate the submission form.
 *
 * When `yaml` is supplied, two extra families of checks run:
 *  1. A CLIENT-SIDE syntax gate (S2): the YAML is parsed with the bundled
 *     `yaml` package. A parse failure is a BLOCKING `field: "yaml"` error.
 *     This is independent of the bridge lint endpoint — so a syntactically
 *     broken recipe can never be submitted even when the bridge is offline
 *     or its lint route returns a non-OK status (401 on a gated deploy, a
 *     network hiccup, etc.). The bridge lint, when reachable, layers richer
 *     schema validation on top; when unreachable the UI degrades to
 *     "syntax validated only" rather than a full bypass.
 *  2. TRUST-CONSISTENCY heuristics (S2): conservative, non-blocking
 *     `level: "warning"` issues flagging obvious contradictions between the
 *     manifest trust dropdowns and what the YAML actually does (see
 *     analyzeTrustConsistency).
 */
export function validateSubmission(
  data: SubmissionFormData,
  yaml?: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!SLUG_RE.test(data.slug)) {
    issues.push({
      field: "slug",
      message:
        "Slug must start with a letter or digit and contain only lowercase letters, digits, and hyphens (max 64 chars).",
    });
  }
  if (!AUTHOR_RE.test(data.author)) {
    issues.push({
      field: "author",
      message:
        "Author handle must follow GitHub username rules: alphanumerics + hyphens, no leading/trailing hyphen, max 39 chars.",
    });
  }
  if (!VERSION_RE.test(data.version)) {
    issues.push({
      field: "version",
      message: "Version must be semver (e.g. 1.0.0 or 1.0.0-beta.1).",
    });
  }
  const desc = data.description.trim();
  if (!desc) {
    issues.push({ field: "description", message: "Description is required." });
  } else if (desc.length > 280) {
    issues.push({
      field: "description",
      message: "Description must be 280 characters or fewer.",
    });
  }
  if (data.tags.length === 0) {
    issues.push({
      field: "tags",
      message: "At least one tag is required.",
    });
  } else if (data.tags.length > 8) {
    issues.push({ field: "tags", message: "Maximum 8 tags." });
  } else {
    const badTag = data.tags.find((t) => !TAG_OR_CONNECTOR_RE.test(t));
    if (badTag !== undefined) {
      issues.push({
        field: "tags",
        message: `Tag "${badTag}" must be lowercase letters/digits/dots/hyphens/underscores (max 32 chars).`,
      });
    }
  }
  if (data.connectors.length > 0) {
    const badConnector = data.connectors.find(
      (c) => !TAG_OR_CONNECTOR_RE.test(c),
    );
    if (badConnector !== undefined) {
      issues.push({
        field: "connectors",
        message: `Connector "${badConnector}" must be lowercase letters/digits/dots/hyphens/underscores (max 32 chars).`,
      });
    }
  }
  if (data.homepage) {
    // Reject NULs / control chars before WHATWG-canonicalisation — a leading
    // a leading NUL makes new URL throw cleanly, but inside the host portion it can
    // sneak through normalisation; HTML attribute parsing later strips the
    // NUL, leaving an attacker-controlled scheme.
    if (/[\x00-\x1f]/.test(data.homepage)) {
      issues.push({
        field: "homepage",
        message: "Homepage must not contain control characters.",
      });
    } else {
      try {
        const url = new URL(data.homepage);
        if (url.protocol !== "https:") {
          issues.push({
            field: "homepage",
            message: "Homepage must be an https:// URL.",
          });
        } else if (!url.hostname) {
          issues.push({
            field: "homepage",
            message: "Homepage must include a hostname.",
          });
        }
      } catch {
        issues.push({
          field: "homepage",
          message: "Homepage must be a valid URL.",
        });
      }
    }
  }

  // ---- YAML-aware checks (S2) -------------------------------------
  // Only run when a YAML doc is supplied. Keeps the data-only call sites
  // (and their existing tests) unchanged.
  if (typeof yaml === "string") {
    const trimmed = yaml.trim();
    if (trimmed.length > 0) {
      let parseFailed = false;
      try {
        parseYaml(yaml);
      } catch (err) {
        parseFailed = true;
        const detail = err instanceof Error ? err.message : String(err);
        // Collapse multi-line parser output to a single line so the inline
        // error box stays compact.
        const oneLine = detail.split("\n")[0]?.trim() || "syntax error";
        issues.push({
          field: "yaml",
          level: "error",
          message: `Recipe YAML is not valid YAML: ${oneLine}`,
        });
      }
      // Trust heuristics need a parseable doc; skip when parsing failed.
      if (!parseFailed) {
        issues.push(...analyzeTrustConsistency(data, yaml));
      }
    }
  }

  return issues;
}

/**
 * Conservative trust-consistency heuristics (S2).
 *
 * buildManifestJson copies the risk/network/file dropdowns straight from
 * the form, so a data-exfiltrating recipe can be declared low-risk /
 * no-access. These heuristics parse the YAML and flag obvious
 * contradictions as NON-BLOCKING warnings. Deliberately conservative —
 * they warn, never block, because a false positive here must not stop a
 * legitimate submission.
 *
 * Detection is text-based against the raw YAML (covers prompts and values
 * uniformly), with the parse already proven to succeed by the caller.
 *
 *  - network_access=false but YAML mentions http(s):// URLs or a
 *    fetch/curl/http(.request) call  → warn on networkAccess.
 *  - file_access=false but YAML has a file read/write op (fs.*,
 *    writeFile/readFile, or a `path:` value)  → warn on fileAccess.
 *  - risk_level=low but a step declares `risk: high|medium`  → warn on
 *    riskLevel.
 */
export function analyzeTrustConsistency(
  data: SubmissionFormData,
  yaml: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Network: declared no-network but the YAML reaches out.
  if (!data.networkAccess) {
    const networkSignal =
      /https?:\/\//i.test(yaml) ||
      /\b(?:fetch|curl|wget|axios|http\.request|sendHttpRequest|webhook)\b/i.test(
        yaml,
      );
    if (networkSignal) {
      issues.push({
        field: "networkAccess",
        level: "warning",
        message:
          'The YAML references network calls (a URL or fetch/http step) but "Makes outbound network requests" is unchecked. Reviewers may flag this — re-check the box if the recipe reaches the network.',
      });
    }
  }

  // Files: declared no-file-access but the YAML reads/writes files.
  if (!data.fileAccess) {
    const fileSignal =
      /\bfs\.[a-z]/i.test(yaml) ||
      /\b(?:writeFile|readFile|createFile|editText|writeFileSync|readFileSync)\b/i.test(
        yaml,
      ) ||
      /^\s*path:\s*\S/m.test(yaml);
    if (fileSignal) {
      issues.push({
        field: "fileAccess",
        level: "warning",
        message:
          'The YAML references local file operations (an fs/writeFile step or a path: value) but "Reads or writes local files" is unchecked. Re-check the box if the recipe touches the filesystem.',
      });
    }
  }

  // Risk: declared low but a step annotates itself higher.
  if (data.riskLevel === "low") {
    const declaresHigherRisk = /^\s*risk:\s*(high|medium)\b/im.test(yaml);
    if (declaresHigherRisk) {
      issues.push({
        field: "riskLevel",
        level: "warning",
        message:
          'A step in the YAML is annotated risk: high/medium but the manifest risk level is "low". Consider raising the risk level so the install confirmation matches.',
      });
    }
  }

  return issues;
}

/** Build the recipe.json manifest content (registry format). */
export function buildManifestJson(data: SubmissionFormData): string {
  const scopedName = `@${data.author}/${data.slug}`;
  const handle = `@${data.author}`;
  const manifest: Record<string, unknown> = {
    name: scopedName,
    version: data.version,
    description: data.description.trim(),
    author: handle,
    license: data.license || "MIT",
    tags: data.tags,
    connectors: data.connectors,
    recipes: { main: "recipe.yaml" },
    risk_level: data.riskLevel,
    network_access: data.networkAccess,
    file_access: data.fileAccess,
    approval_behavior: data.approvalBehavior,
    maintainer: handle,
  };
  if (data.homepage) {
    // Store the WHATWG-canonical form, not the raw user input. Strips
    // whitespace/NUL/case quirks that downstream renderers could mishandle.
    try {
      manifest.homepage = new URL(data.homepage).toString();
    } catch {
      // validateSubmission already rejects malformed URLs; this branch is
      // reached only if a caller skipped validation.
      manifest.homepage = data.homepage;
    }
  }
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Repository-relative path for the recipe.yaml file. */
export function recipeYamlPath(data: SubmissionFormData): string {
  return `recipes/${data.slug}/recipe.yaml`;
}

/** Repository-relative path for the recipe.json manifest file. */
export function recipeJsonPath(data: SubmissionFormData): string {
  return `recipes/${data.slug}/recipe.json`;
}

/** The install string that ends up in the registry index for this recipe. */
export function installSourceFor(data: SubmissionFormData): string {
  return `github:${REGISTRY_OWNER}/${REGISTRY_REPO}/recipes/${data.slug}`;
}

/**
 * Build a GitHub "create new file" URL with the filename and content
 * pre-filled. Opening this URL takes the user straight to the create-file
 * form on the registry repo. If they don't have push access, GitHub
 * auto-forks first. After commit, GitHub shows a "Propose new file"
 * button that opens a PR back to the upstream registry.
 */
export function buildGithubCreateFileUrl(opts: {
  owner?: string;
  repo?: string;
  branch?: string;
  filename: string;
  content: string;
  message?: string;
  description?: string;
}): string {
  const owner = opts.owner ?? REGISTRY_OWNER;
  const repo = opts.repo ?? REGISTRY_REPO;
  const branch = opts.branch ?? REGISTRY_BRANCH;
  const params = new URLSearchParams();
  params.set("filename", opts.filename);
  params.set("value", opts.content);
  if (opts.message) params.set("message", opts.message);
  if (opts.description) params.set("description", opts.description);
  return `https://github.com/${owner}/${repo}/new/${branch}?${params.toString()}`;
}

/**
 * URL size threshold beyond which GitHub may silently truncate the
 * prefilled value. Practical browser/GitHub limit is around 8 KB; we
 * warn earlier so the user knows to verify the editor content before
 * committing.
 */
export const URL_SAFE_CONTENT_LIMIT = 7000;
