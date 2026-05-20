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
 * The repo-relative path of the file for a parsed install source.
 * `recipes/<name>/<name>.yaml` or `bundles/<name>/patchwork-bundle.json`.
 */
function repoRelativePath(parsed: ParsedGithubInstallSource): string {
  if (parsed.kind === "recipe") {
    return `recipes/${parsed.name}/${parsed.name}.yaml`;
  }
  return `bundles/${parsed.name}/patchwork-bundle.json`;
}

/**
 * Build the raw.githubusercontent URL for a parsed install source.
 * Always pulls `main` branch HEAD — version pinning is on the
 * deferred audit backlog.
 */
export function buildGithubRawUrl(parsed: ParsedGithubInstallSource): string {
  return `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/main/${repoRelativePath(parsed)}`;
}

/**
 * Build the `api.github.com` Contents-API URL for a parsed install
 * source. Used as a FALLBACK when `raw.githubusercontent.com` is
 * unreachable — many corporate / proxied networks block the raw host
 * even when `api.github.com` is allowed. Combined with the
 * `Accept: application/vnd.github.raw` request header (see
 * `fetchGithubInstallFile`), this endpoint returns the raw file bytes
 * directly — no base64 decode needed. Public repos work unauthenticated.
 */
export function buildGithubApiUrl(parsed: ParsedGithubInstallSource): string {
  return `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/contents/${repoRelativePath(parsed)}?ref=main`;
}

/**
 * Fetch a recipe / bundle file for a parsed `github:` install source
 * with a raw-host-first, API-fallback strategy.
 *
 *   1. Try `raw.githubusercontent.com` (fast path, no rate limit).
 *   2. If that throws a network error OR returns a non-ok response,
 *      fall back to `api.github.com/repos/.../contents/...` with the
 *      `Accept: application/vnd.github.raw` header (returns raw bytes).
 *
 * Return contract — designed so the caller's existing error mapping
 * (502 / `fetch_network_error`, 404 not-found, upstream-error) is
 * unchanged:
 *
 *   - `{ ok: true, response }` — a usable ok `Response`, from whichever
 *     host succeeded. Caller reads the body as before.
 *   - `{ ok: false, kind: "not_found", response }` — BOTH hosts agree
 *     the file does not exist (raw 404 AND api 404). Caller surfaces
 *     this as a genuine not-found (404), not a network error.
 *   - `{ ok: false, kind: "upstream_error", response }` — a non-ok,
 *     non-404 HTTP response (e.g. 5xx / 403 rate-limit). Caller maps
 *     the upstream status as today.
 *   - `{ ok: false, kind: "network_error", error }` — both hosts threw
 *     a network-level error (DNS / connect / abort). Caller surfaces
 *     the existing 502 `fetch_network_error` shape.
 *
 * `signal` (caller's AbortController) and timeout behaviour are
 * preserved — the same signal is passed to both fetch attempts.
 */
export type GithubInstallFetchResult =
  | { ok: true; response: Response }
  | { ok: false; kind: "not_found"; response: Response }
  | { ok: false; kind: "upstream_error"; response: Response }
  | { ok: false; kind: "network_error"; error: unknown };

export async function fetchGithubInstallFile(
  parsed: ParsedGithubInstallSource,
  init: { signal?: AbortSignal } = {},
): Promise<GithubInstallFetchResult> {
  const rawUrl = buildGithubRawUrl(parsed);
  let rawResponse: Response | null = null;
  let rawNetworkError: unknown = null;
  try {
    rawResponse = await fetch(rawUrl, {
      signal: init.signal,
      redirect: "follow",
    });
  } catch (err) {
    rawNetworkError = err;
  }

  // Fast path: raw host returned a usable response.
  if (rawResponse?.ok) {
    return { ok: true, response: rawResponse };
  }

  // Raw host either threw OR returned non-ok → try the API fallback.
  const apiUrl = buildGithubApiUrl(parsed);
  let apiResponse: Response | null = null;
  let apiNetworkError: unknown = null;
  try {
    apiResponse = await fetch(apiUrl, {
      signal: init.signal,
      redirect: "follow",
      headers: { Accept: "application/vnd.github.raw" },
    });
  } catch (err) {
    apiNetworkError = err;
  }

  if (apiResponse?.ok) {
    return { ok: true, response: apiResponse };
  }

  // Neither host yielded an ok body. Decide which failure to surface.
  //
  // A non-404 HTTP failure (5xx / 403 rate-limit) is the most
  // actionable signal — prefer it over a 404 from the other host, so a
  // transient upstream problem isn't misreported as "recipe missing".
  // The API response is the more authoritative of the two here (raw is
  // a CDN; the API gives proper status codes), so check it first.
  if (apiResponse && apiResponse.status !== 404) {
    return { ok: false, kind: "upstream_error", response: apiResponse };
  }
  if (rawResponse && rawResponse.status !== 404) {
    return { ok: false, kind: "upstream_error", response: rawResponse };
  }
  // Whatever is left is a genuine 404 from one or both hosts → keep
  // the not-found distinction so the caller surfaces a 404, not a 502.
  if (apiResponse && apiResponse.status === 404) {
    return { ok: false, kind: "not_found", response: apiResponse };
  }
  if (rawResponse && rawResponse.status === 404) {
    return { ok: false, kind: "not_found", response: rawResponse };
  }
  // Both hosts threw network errors.
  return {
    ok: false,
    kind: "network_error",
    error: apiNetworkError ?? rawNetworkError,
  };
}
