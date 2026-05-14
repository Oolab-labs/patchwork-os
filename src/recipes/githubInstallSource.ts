/**
 * Parses + allowlists the `github:<owner>/<repo>/(recipes|bundles)/<name>`
 * source format used by `POST /recipes/install`.
 *
 * Before this module existed, the install handler hard-coded
 * `github:patchworkos/recipes/...` everywhere — every URL, every
 * prefix match. Third-party orgs / forks / private mirrors could not
 * host recipe catalogs even though the rest of the install pipeline
 * (SSRF guard, parser, scheduler) is org-agnostic.
 *
 * Allowlist policy:
 *   - Always includes `patchworkos/recipes` (backward compat).
 *   - Operator opts in additional `<owner>/<repo>` entries via the
 *     `PATCHWORK_RECIPE_REPO_ALLOWLIST` env var (comma-separated).
 *   - Allowlist matching is case-insensitive (GitHub itself is).
 *   - Both owner and repo segments must match the strict regex
 *     `[a-z0-9_.-]{1,100}` AFTER lowercasing — guards against
 *     traversal segments smuggled into the source string.
 *
 * The default-only behaviour matches the audit recommendation: real
 * multi-org support is opt-in, so existing single-org deployments
 * don't see a behaviour change.
 */

export type GithubInstallKind = "recipe" | "bundle";

export interface ParsedGithubInstallSource {
  kind: GithubInstallKind;
  owner: string;
  repo: string;
  /** Recipe name (single basename) or bundle name. */
  name: string;
}

export type GithubInstallParseResult =
  | { ok: true; parsed: ParsedGithubInstallSource }
  | {
      ok: false;
      code: "bad_shape" | "bad_segment" | "not_allowlisted";
      error: string;
    };

const DEFAULT_ALLOWLIST: ReadonlyArray<string> = ["patchworkos/recipes"];
const SEGMENT_RE = /^[a-z0-9_.-]{1,100}$/;

/**
 * Read the runtime allowlist. Combines the always-on default with
 * whatever the operator has set in PATCHWORK_RECIPE_REPO_ALLOWLIST.
 * Entries are lowercased + de-duplicated; trailing whitespace, empty
 * fragments, and shapes that don't look like `owner/repo` are
 * silently dropped (logging here is the install handler's job, not
 * this pure helper's).
 */
export function loadAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  const fromEnv = (env.PATCHWORK_RECIPE_REPO_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && s.includes("/"));
  return Array.from(new Set([...DEFAULT_ALLOWLIST, ...fromEnv]));
}

/**
 * Parse a `github:owner/repo/(recipes|bundles)/name` source string
 * against the active allowlist. Pure — does NOT fetch anything; the
 * install handler is responsible for the network leg and the SSRF
 * guard. Returns a discriminated union the caller can map to a 400
 * (bad_shape / bad_segment) or 403 (not_allowlisted) response.
 */
export function parseGithubInstallSource(
  source: string,
  allowlist: ReadonlyArray<string> = loadAllowlist(),
): GithubInstallParseResult {
  if (!source.startsWith("github:")) {
    return {
      ok: false,
      code: "bad_shape",
      error: "source must start with 'github:'",
    };
  }
  // After the `github:` prefix we expect <owner>/<repo>/<kind>/<name>.
  // We split into exactly 4 segments — extra trailing slashes or
  // missing components are rejected with `bad_shape` so the response
  // is actionable.
  const tail = source.slice("github:".length);
  const segments = tail.split("/");
  if (segments.length !== 4) {
    return {
      ok: false,
      code: "bad_shape",
      error:
        "source must match 'github:<owner>/<repo>/(recipes|bundles)/<name>'",
    };
  }
  const [ownerRaw, repoRaw, kindRaw, nameRaw] = segments as [
    string,
    string,
    string,
    string,
  ];
  const owner = ownerRaw.toLowerCase();
  const repo = repoRaw.toLowerCase();
  if (!SEGMENT_RE.test(owner) || !SEGMENT_RE.test(repo)) {
    return {
      ok: false,
      code: "bad_segment",
      error: "owner and repo must match [a-z0-9_.-]{1,100}",
    };
  }
  if (kindRaw !== "recipes" && kindRaw !== "bundles") {
    return {
      ok: false,
      code: "bad_shape",
      error: "third path segment must be 'recipes' or 'bundles'",
    };
  }
  // Reuse the strict basename predicate inline rather than importing
  // recipeInstall.ts here (circular deps), but match its rules:
  // single segment, no `..`, no slashes, conservative charset, ≤100.
  if (!SEGMENT_RE.test(nameRaw.toLowerCase())) {
    return {
      ok: false,
      code: "bad_segment",
      error: "name must match [a-z0-9_.-]{1,100}",
    };
  }
  const allowSet = new Set(allowlist.map((s) => s.toLowerCase()));
  if (!allowSet.has(`${owner}/${repo}`)) {
    return {
      ok: false,
      code: "not_allowlisted",
      error: `'${owner}/${repo}' is not in the recipe-repo allowlist. Set PATCHWORK_RECIPE_REPO_ALLOWLIST=${owner}/${repo} to opt in.`,
    };
  }
  return {
    ok: true,
    parsed: {
      kind: kindRaw === "recipes" ? "recipe" : "bundle",
      owner,
      repo,
      name: nameRaw,
    },
  };
}

/**
 * Build the raw.githubusercontent URL for a parsed install source.
 * Always pulls `main` branch HEAD — version pinning is on the
 * deferred audit backlog.
 */
export function buildGithubRawUrl(parsed: ParsedGithubInstallSource): string {
  if (parsed.kind === "recipe") {
    return `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/main/recipes/${parsed.name}/${parsed.name}.yaml`;
  }
  return `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/main/bundles/${parsed.name}/patchwork-bundle.json`;
}
