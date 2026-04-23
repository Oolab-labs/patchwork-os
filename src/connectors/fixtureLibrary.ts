import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface FixtureError {
  code?: string;
  message: string;
  retryable?: boolean;
}

export interface FixtureEntry {
  operation: string;
  input?: unknown;
  output?: unknown;
  error?: FixtureError;
}

export interface FixtureLibrary {
  version: 1;
  provider: string;
  fixtures: FixtureEntry[];
}

export function createFixtureLibrary(provider: string): FixtureLibrary {
  return {
    version: 1,
    provider,
    fixtures: [],
  };
}

export function loadFixtureLibrary(filePath: string): FixtureLibrary | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<FixtureLibrary>;
    if (
      parsed.version !== 1 ||
      typeof parsed.provider !== "string" ||
      !Array.isArray(parsed.fixtures)
    ) {
      return null;
    }
    return {
      version: 1,
      provider: parsed.provider,
      fixtures: parsed.fixtures,
    };
  } catch {
    return null;
  }
}

export function saveFixtureLibrary(
  filePath: string,
  library: FixtureLibrary,
): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, JSON.stringify(library, null, 2));
}

export function recordFixture(
  filePath: string,
  provider: string,
  entry: FixtureEntry,
): FixtureLibrary {
  const library =
    loadFixtureLibrary(filePath) ?? createFixtureLibrary(provider);
  library.fixtures.push(entry);
  saveFixtureLibrary(filePath, library);
  return library;
}

export function findFixture(
  library: FixtureLibrary,
  operation: string,
  input?: unknown,
): FixtureEntry | null {
  const target = stableStringify(input ?? null);
  for (const fixture of library.fixtures) {
    if (fixture.operation !== operation) {
      continue;
    }
    if (stableStringify(fixture.input ?? null) === target) {
      return fixture;
    }
  }
  return null;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    return Object.fromEntries(
      entries.map(([key, nested]) => [key, sortValue(nested)]),
    );
  }
  return value;
}
