/**
 * Shared types + helpers for the marketplace registry (read-only).
 *
 * Sources data from `https://raw.githubusercontent.com/patchworkos/recipes/main/`.
 */

export interface RegistryRecipe {
  name: string;
  version: string;
  description: string;
  tags: string[];
  connectors: string[];
  install: string;
  downloads: number;
}

export interface RegistryData {
  version: string;
  updated_at: string;
  recipes: RegistryRecipe[];
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
    });
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
    });
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
    });
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

/** Strip the `@scope/` prefix for display. */
export function shortName(name: string): string {
  return name.replace(/^@[^/]+\//, "");
}
