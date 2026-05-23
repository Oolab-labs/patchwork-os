/**
 * Shared types + helpers for the marketplace registry (read-only).
 *
 * Sources data from `https://raw.githubusercontent.com/patchworkos/recipes/main/`.
 */

import { parse as parseYaml } from "yaml";

export type RiskLevel = "low" | "medium" | "high";
export type ApprovalBehavior = "always_ask" | "ask_on_novel" | "auto_approve";

export interface TrustMetadata {
  /** Overall risk level derived from the recipe's step risk annotations. */
  risk_level?: RiskLevel;
  /** Whether the recipe makes outbound network requests. */
  network_access?: boolean;
  /** Whether the recipe reads or writes local files. */
  file_access?: boolean;
  /**
   * How the recipe behaves with the bridge's approval gate:
   *   "always_ask"   — every run requires manual approval
   *   "ask_on_novel" — prompts when a new tool / specifier is seen
   *   "auto_approve" — designed to run fully unattended once trusted
   */
  approval_behavior?: ApprovalBehavior;
  /** npm package name or GitHub handle of the recipe maintainer. */
  maintainer?: string;
}

export interface RegistryRecipe extends TrustMetadata {
  name: string;
  version: string;
  description: string;
  tags: string[];
  connectors: string[];
  install: string;
  downloads: number;
}

/**
 * A capability bundle packages a plugin + recipes + policy template +
 * connector requirements into a single installable unit.
 *
 * Structure on disk / in the registry:
 *
 *   my-bundle/
 *     patchwork-bundle.json   ← this manifest
 *     recipes/                ← one or more recipe YAML files
 *     policy-template.json    ← delegation policy fragment (optional)
 *     plugin/                 ← npm package or local plugin dir (optional)
 *     README.md
 *
 * The install field uses the same `github:owner/repo/path@ref` shape
 * as RegistryRecipe so the same parseInstallSource helper works.
 */
export interface BundleManifest extends TrustMetadata {
  /** Scoped package name, e.g. "@patchworkos/gmail-vip-support". */
  name: string;
  version: string;
  description: string;
  /** Short human label shown in the marketplace tile. */
  display_name?: string;
  author?: string;
  license?: string;
  homepage?: string;
  tags: string[];
  /** Connector namespaces required by the bundle (e.g. "gmail", "linear"). */
  connectors: string[];
  /** Recipe YAML files included in the bundle (relative paths). */
  recipes: string[];
  /**
   * npm package name of the companion plugin, if the bundle ships one.
   * When present the install flow prompts the user to `npm install -g`
   * the plugin before activating recipes.
   */
  plugin?: string;
  /**
   * Relative path to the policy-template.json fragment inside the bundle.
   * Applied with user confirmation during install — never silently.
   */
  policy_template?: string;
  /**
   * Environment variable names the bundle requires (connector credentials,
   * API keys, etc.). Shown as a checklist before install.
   */
  required_env?: string[];
}

export interface RegistryBundle extends TrustMetadata {
  name: string;
  version: string;
  description: string;
  tags: string[];
  connectors: string[];
  /** Same `github:owner/repo/path@ref` shape as RegistryRecipe. */
  install: string;
  downloads: number;
  /** Whether the bundle ships a companion plugin. */
  has_plugin?: boolean;
  /** Number of recipes included in the bundle. */
  recipe_count?: number;
  /** Whether the bundle includes a policy template fragment. */
  has_policy?: boolean;
}

export interface RegistryData {
  version: string;
  updated_at: string;
  recipes: RegistryRecipe[];
  /** Capability bundles (plugin + recipes + policy template). Added in registry v2. */
  bundles?: RegistryBundle[];
}

export interface RecipeManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  tags?: string[];
  connectors?: string[];
  recipes?: { main?: string; children?: string[] };
  variables?: Record<
    string,
    { description?: string; required?: boolean; default?: string }
  >;
  homepage?: string;
}

export interface ParsedInstallSource {
  owner: string;
  repo: string;
  path: string;
  ref: string;
}

const RAW_BASE = "https://raw.githubusercontent.com";

/** Parse an install string like `github:owner/repo/sub/dir@ref`. */
export function parseInstallSource(install: string): ParsedInstallSource | null {
  const match = /^github:([^/]+)\/([^/@]+)(?:\/([^@]+))?(?:@(.+))?$/.exec(install);
  if (!match) return null;
  return {
    owner: match[1] ?? "",
    repo: match[2] ?? "",
    path: (match[3] ?? "").replace(/\/$/, ""),
    ref: match[4] ?? "main",
  };
}

/**
 * Defense-in-depth validator for marketplace install POST sites.
 *
 * Throws a user-facing Error when the install string isn't shaped like a
 * `github:owner/repo[/path]@ref` URL — covers tampered registry indexes,
 * MITM-flipped responses, and accidental opaque-passthrough at call sites.
 * The bridge also validates server-side; this is the dashboard layer's
 * "block the obvious attack before we forward" safety net.
 */
export function assertValidInstallSource(install: string): ParsedInstallSource {
  if (typeof install !== "string" || install.trim().length === 0) {
    throw new Error(
      "Invalid install source: expected non-empty string in `github:owner/repo[/path]@ref` form",
    );
  }
  const parsed = parseInstallSource(install);
  if (!parsed || !parsed.owner || !parsed.repo) {
    throw new Error(
      "Invalid install source: must match `github:owner/repo[/path]@ref` (refusing to forward to bridge)",
    );
  }
  // Reject path-traversal segments (audit 2026-05-17). The bridge's
  // `parseGithubInstallSource` is strict-segment (charset `[a-z0-9_.-]`),
  // so `..` would fail server-side anyway — but the dashboard's
  // "defense-in-depth" promise should fail fast and visibly.
  if (parsed.path.length > 0) {
    const dangerousSegment = parsed.path
      .split("/")
      .some((seg) => seg === ".." || seg === "." || seg === "");
    if (dangerousSegment) {
      throw new Error(
        "Invalid install source: path segments must not contain '.' or '..' (refusing to forward to bridge)",
      );
    }
  }
  return parsed;
}

export function rawUrlFor(src: ParsedInstallSource, file: string): string {
  const parts = [src.owner, src.repo, src.ref, src.path, file].filter(Boolean);
  return `${RAW_BASE}/${parts.join("/")}`;
}

/**
 * GitHub Contents-API URL for the same file `rawUrlFor` resolves.
 *
 * `raw.githubusercontent.com` is blocked on many corporate / proxied /
 * sandboxed networks even when `github.com` + `api.github.com` are
 * reachable. The Contents API is the fallback path. With the
 * `Accept: application/vnd.github.raw` request header the API returns the
 * raw file bytes directly — no base64 decode needed.
 */
export function contentsApiUrlFor(src: ParsedInstallSource, file: string): string {
  const filePath = [src.path, file].filter(Boolean).join("/");
  // Encode every interpolated segment so the URL builder is self-safe — even
  // though parseInstallSource already constrains owner/repo, a stray `/` or
  // `?` in any field must not be able to escape its path component.
  const owner = encodeURIComponent(src.owner);
  const repo = encodeURIComponent(src.repo);
  const ref = encodeURIComponent(src.ref);
  return `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${ref}`;
}

export function githubBlobUrlFor(src: ParsedInstallSource, file: string): string {
  const parts = [src.path, file].filter(Boolean).join("/");
  return `https://github.com/${src.owner}/${src.repo}/blob/${src.ref}/${parts}`;
}

interface FetchOpts {
  /** Cache TTL in seconds for ISR. Default 300. */
  revalidate?: number;
  /** Optional abort signal, forwarded to every underlying fetch. */
  signal?: AbortSignal;
}

/** The registry index lives at `patchworkos/recipes/index.json@main`. */
const REGISTRY_INDEX_SRC: ParsedInstallSource = {
  owner: "patchworkos",
  repo: "recipes",
  path: "",
  ref: "main",
};

/**
 * Fetch a single text file from a GitHub repo, with a network-resilience
 * fallback.
 *
 * Strategy:
 *   1. Try `raw.githubusercontent.com` first — fast, CDN-backed, and
 *      friendly to unauthenticated reads.
 *   2. If that throws (network error / blocked host) OR returns a non-ok
 *      response, fall back to the `api.github.com` Contents API with the
 *      `Accept: application/vnd.github.raw` header so the raw bytes come
 *      back directly (no base64 decode).
 *
 * `raw.githubusercontent.com` is blocked on many corporate / proxied /
 * sandboxed networks even when `github.com` + `api.github.com` are
 * reachable, which previously broke marketplace browse + install 100%.
 *
 * Returns the file text, or `null` if BOTH endpoints fail. No auth token
 * is attached — both endpoints work unauthenticated for public repos.
 * The Contents API has a 60 req/hr unauthenticated rate limit; that is
 * acceptable for this read path (it is only hit when raw is unreachable).
 */
export async function fetchGithubFile(
  src: ParsedInstallSource,
  file: string,
  opts: FetchOpts = {},
): Promise<string | null> {
  const revalidate = opts.revalidate ?? 300;
  const init = {
    next: { revalidate },
    signal: opts.signal,
  } as RequestInit;

  // 1. raw.githubusercontent.com (preferred)
  try {
    const res = await fetch(rawUrlFor(src, file), init);
    if (res.ok) return await res.text();
  } catch {
    // fall through to the API fallback
  }

  // 2. api.github.com Contents API (fallback for raw-blocked networks)
  try {
    const res = await fetch(contentsApiUrlFor(src, file), {
      ...init,
      headers: { Accept: "application/vnd.github.raw" },
    } as RequestInit);
    if (res.ok) return await res.text();
  } catch {
    // both endpoints failed
  }

  return null;
}

export async function fetchRegistry(opts: FetchOpts = {}): Promise<RegistryData | null> {
  const text = await fetchGithubFile(REGISTRY_INDEX_SRC, "index.json", opts);
  if (text === null) return null;
  try {
    return JSON.parse(text) as RegistryData;
  } catch {
    return null;
  }
}

export async function fetchManifest(
  src: ParsedInstallSource,
  opts: FetchOpts = {},
): Promise<RecipeManifest | null> {
  const text = await fetchGithubFile(src, "recipe.json", opts);
  if (text === null) return null;
  try {
    return JSON.parse(text) as RecipeManifest;
  } catch {
    return null;
  }
}

export async function fetchRecipeYaml(
  src: ParsedInstallSource,
  mainFile: string,
  opts: FetchOpts = {},
): Promise<string | null> {
  return fetchGithubFile(src, mainFile, opts);
}

/**
 * Risk-level summary for the detail-page "Steps & risk" card.
 *
 * Walks `steps[].risk` via a real YAML parse, then counts low / medium /
 * high values. Pre-fix used regex against `^\s*risk:` which over-counted
 * any `risk:` substring inside multi-line block scalars (e.g.
 * `prompt: |` followed by indented prose containing the word) and any
 * nested object with a `risk:` key in a non-step position. False
 * positives showed up in real recipes (morning-brief's narration
 * prompt contains "risk: high").
 *
 * Parser is `yaml` (already in deps for the recipe-editor). Returns
 * zeros on parse failure rather than throwing — the panel is a hint,
 * not a gate.
 */
export function summarizeRisk(yaml: string): {
  low: number;
  medium: number;
  high: number;
  steps: number;
} {
  let doc: unknown;
  try {
    doc = parseYaml(yaml);
  } catch {
    return { low: 0, medium: 0, high: 0, steps: 0 };
  }
  const steps =
    doc !== null &&
    typeof doc === "object" &&
    Array.isArray((doc as { steps?: unknown }).steps)
      ? ((doc as { steps: unknown[] }).steps)
      : [];
  let low = 0;
  let medium = 0;
  let high = 0;
  for (const step of steps) {
    if (step === null || typeof step !== "object") continue;
    const r = (step as { risk?: unknown }).risk;
    if (r === "low") low++;
    else if (r === "medium") medium++;
    else if (r === "high") high++;
  }
  return { low, medium, high, steps: steps.length };
}

export async function fetchBundleManifest(
  src: ParsedInstallSource,
  opts: FetchOpts = {},
): Promise<BundleManifest | null> {
  const text = await fetchGithubFile(src, "patchwork-bundle.json", opts);
  if (text === null) return null;
  try {
    return JSON.parse(text) as BundleManifest;
  } catch {
    return null;
  }
}

/** Strip the `@scope/` prefix for display. */
export function shortName(name: string): string {
  return name.replace(/^@[^/]+\//, "");
}

/**
 * Canonical connector ids match the bridge's `connectorRegistry.ts` —
 * kebab-case, no namespace. Recipes in the wild use three spellings of
 * the Google Calendar one (`googleCalendar` in the live registry,
 * `calendar` in the old fallback data, `google-calendar` everywhere
 * else). Map all known aliases to the canonical id at the dashboard
 * boundary so chip rendering, install dialogs, and the deep-link target
 * on `/connections#<id>` are consistent.
 *
 * Adding a new alias is cheaper than fixing every consumer. The bridge
 * `KNOWN_CONNECTOR_IDS` set in `app/recipes/[name]/layout.tsx` is the
 * authoritative target — entries here must resolve into that set.
 */
const CONNECTOR_ID_ALIASES: Record<string, string> = {
  googlecalendar: "google-calendar",
  calendar: "google-calendar",
  gcal: "google-calendar",
  googledrive: "google-drive",
  gdrive: "google-drive",
  googledocs: "google-docs",
  gdocs: "google-docs",
  docs: "google-docs",
  mongo: "mongodb",
  es: "elasticsearch",
};

export function normalizeConnectorId(raw: string): string {
  const lower = raw.toLowerCase();
  return CONNECTOR_ID_ALIASES[lower] ?? lower;
}

/**
 * Render a connector id (e.g. "google-calendar", "slack") as a
 * user-facing label. Title-cases each hyphen segment; special-cases a
 * couple of acronyms that look wrong with vanilla title-case.
 *
 * Shared between the browse-view RecipeCard's post-install
 * missing-connectors toast and the detail-page InstallPanel /
 * BundleInstallPanel inline notices. Keep terse — no marketing copy.
 */
export function formatConnectorLabel(rawId: string): string {
  const id = normalizeConnectorId(rawId);
  if (id === "github") return "GitHub";
  if (id === "gitlab") return "GitLab";
  if (id === "pagerduty") return "PagerDuty";
  if (id === "hubspot") return "HubSpot";
  if (id === "sendgrid") return "SendGrid";
  if (id === "mongodb") return "MongoDB";
  return id
    .split("-")
    .map((part) =>
      part.length === 0 ? "" : part[0].toUpperCase() + part.slice(1),
    )
    .join(" ");
}
