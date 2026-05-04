/**
 * Shared types + helpers for the marketplace registry (read-only).
 *
 * Sources data from `https://raw.githubusercontent.com/patchworkos/recipes/main/`.
 */

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

const REGISTRY_INDEX_URL =
  "https://raw.githubusercontent.com/patchworkos/recipes/main/index.json";

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
  return parsed;
}

export function rawUrlFor(src: ParsedInstallSource, file: string): string {
  const parts = [src.owner, src.repo, src.ref, src.path, file].filter(Boolean);
  return `${RAW_BASE}/${parts.join("/")}`;
}

export function githubBlobUrlFor(src: ParsedInstallSource, file: string): string {
  const parts = [src.path, file].filter(Boolean).join("/");
  return `https://github.com/${src.owner}/${src.repo}/blob/${src.ref}/${parts}`;
}

interface FetchOpts {
  /** Cache TTL in seconds for ISR. Default 300. */
  revalidate?: number;
}

export async function fetchRegistry(opts: FetchOpts = {}): Promise<RegistryData | null> {
  try {
    const res = await fetch(REGISTRY_INDEX_URL, {
      next: { revalidate: opts.revalidate ?? 300 },
    } as RequestInit);
    if (!res.ok) return null;
    return (await res.json()) as RegistryData;
  } catch {
    return null;
  }
}

export async function fetchManifest(
  src: ParsedInstallSource,
  opts: FetchOpts = {},
): Promise<RecipeManifest | null> {
  try {
    const res = await fetch(rawUrlFor(src, "recipe.json"), {
      next: { revalidate: opts.revalidate ?? 300 },
    } as RequestInit);
    if (!res.ok) return null;
    return (await res.json()) as RecipeManifest;
  } catch {
    return null;
  }
}

export async function fetchRecipeYaml(
  src: ParsedInstallSource,
  mainFile: string,
  opts: FetchOpts = {},
): Promise<string | null> {
  try {
    const res = await fetch(rawUrlFor(src, mainFile), {
      next: { revalidate: opts.revalidate ?? 300 },
    } as RequestInit);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Crude risk-level extractor — counts `risk: low|medium|high` occurrences in YAML.
 * Avoids a full YAML parser dependency for what's just a UI summary.
 */
export function summarizeRisk(yaml: string): {
  low: number;
  medium: number;
  high: number;
  steps: number;
} {
  const low = (yaml.match(/^\s*risk:\s*low\b/gm) ?? []).length;
  const medium = (yaml.match(/^\s*risk:\s*medium\b/gm) ?? []).length;
  const high = (yaml.match(/^\s*risk:\s*high\b/gm) ?? []).length;
  const steps = (yaml.match(/^\s*-\s*id:\s+\S/gm) ?? []).length;
  return { low, medium, high, steps };
}

export async function fetchBundleManifest(
  src: ParsedInstallSource,
  opts: FetchOpts = {},
): Promise<BundleManifest | null> {
  try {
    const res = await fetch(rawUrlFor(src, "patchwork-bundle.json"), {
      next: { revalidate: opts.revalidate ?? 300 },
    } as RequestInit);
    if (!res.ok) return null;
    return (await res.json()) as BundleManifest;
  } catch {
    return null;
  }
}

/** Strip the `@scope/` prefix for display. */
export function shortName(name: string): string {
  return name.replace(/^@[^/]+\//, "");
}
