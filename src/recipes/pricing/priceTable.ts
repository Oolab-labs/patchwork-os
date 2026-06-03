/**
 * Model price table — cost-aware routing Phase 2 (dormant data).
 *
 * A `(model id) → USD-per-million-tokens` table plus a loader. Nothing
 * consumes it yet; Phase 3 wires `costUsd()` into RunBudget so `budget.usdMax`
 * can be enforced for *measured* (API) drivers. Lands separately so the price
 * data can be reviewed for accuracy on its own.
 *
 * Design notes (docs/design/cost-aware-routing.md):
 *   - Prices are DATA, not code, and OVERRIDABLE without a release:
 *       precedence  env `PATCHWORK_PRICE_TABLE` (path)  >
 *                   `~/.patchwork/prices.json`          >
 *                   the built-in table below.
 *   - FAIL-OPEN everywhere: an unknown model, a malformed override, or a
 *     missing file never throws — `costUsd` just returns `undefined` (and the
 *     budget layer treats that as "unpriceable → don't enforce").
 *   - The built-in default lives here as a TS const (compiled into dist, so it
 *     is always available at runtime); overrides are JSON read from disk.
 *   - NO runtime network calls. Prices drift; refresh the const below and bump
 *     `_generatedAt`. `isPriceTableStale()` is provided for a scheduled check.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** USD per 1,000,000 tokens, split by input vs output. */
export interface ModelPrice {
  input: number;
  output: number;
}

export interface PriceTableMeta {
  /** ISO date (YYYY-MM-DD) the built-in prices were last reviewed. */
  _generatedAt: string;
  _unit: "usd_per_million_tokens";
  _source: string;
  _note: string;
  /** Set by the loader when an override file was merged in. */
  _override?: string;
}

export interface PriceTable {
  _meta: PriceTableMeta;
  /** Keyed by exact model id (e.g. "gpt-4o", "claude-haiku-4-5-20251001"). */
  prices: Record<string, ModelPrice>;
}

/**
 * Built-in default prices. **Approximate public list prices** (USD / 1M tokens)
 * as of `_generatedAt` — VERIFY before relying on a USD cap; they drift, and a
 * subscription/CLI driver's spend is notional, not real money out. Override via
 * `~/.patchwork/prices.json` or `PATCHWORK_PRICE_TABLE`.
 */
export const BUILTIN_PRICE_TABLE: PriceTable = {
  _meta: {
    _generatedAt: "2026-06-03",
    _unit: "usd_per_million_tokens",
    _source: "provider public list prices",
    _note:
      "Approximate list prices (USD per 1M tokens). Review before relying on budget.usdMax; override via ~/.patchwork/prices.json or PATCHWORK_PRICE_TABLE.",
  },
  prices: {
    // Anthropic (Claude 4.x)
    "claude-opus-4-8": { input: 15, output: 75 },
    "claude-sonnet-4-6": { input: 3, output: 15 },
    "claude-haiku-4-5-20251001": { input: 1, output: 5 },
    // OpenAI
    "gpt-4o": { input: 2.5, output: 10 },
    "gpt-4o-mini": { input: 0.15, output: 0.6 },
    // xAI (Grok)
    "grok-2-latest": { input: 2, output: 10 },
    // Google (Gemini, API-keyed)
    "gemini-2.5-pro": { input: 1.25, output: 10 },
    "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  },
};

const MS_PER_DAY = 86_400_000;

/** Resolve the override file path per the precedence rule (or undefined). */
function resolveOverridePath(
  env: NodeJS.ProcessEnv,
  homeDir: string,
): string | undefined {
  const envPath = env.PATCHWORK_PRICE_TABLE;
  if (typeof envPath === "string" && envPath.trim()) return envPath.trim();
  const filePath = join(homeDir, ".patchwork", "prices.json");
  return existsSync(filePath) ? filePath : undefined;
}

/** Extract a valid `{input, output}` price from an unknown override entry. */
function coercePrice(value: unknown): ModelPrice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.input === "number" && typeof v.output === "number") {
    return { input: v.input, output: v.output };
  }
  return undefined;
}

/**
 * Load the effective price table: the built-in default with any override file
 * merged over its `prices`. Fail-open — an unreadable / malformed override is
 * ignored and the built-in is returned unchanged.
 *
 * Override file shape: `{ "prices": { "<model>": { "input": N, "output": N } } }`
 * (a bare `{ "<model>": { ... } }` map is also accepted for convenience).
 */
export function loadPriceTable(
  opts: { env?: NodeJS.ProcessEnv; homeDir?: string } = {},
): PriceTable {
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? homedir();
  const overridePath = resolveOverridePath(env, homeDir);
  if (!overridePath) return BUILTIN_PRICE_TABLE;

  try {
    const parsed: unknown = JSON.parse(readFileSync(overridePath, "utf8"));
    const root = (parsed ?? {}) as Record<string, unknown>;
    const rawPrices =
      root.prices && typeof root.prices === "object" ? root.prices : root;

    // Null-prototype base so a user override keyed "__proto__" creates an own
    // property instead of mutating the prototype (bracket-assign pollution).
    const merged: Record<string, ModelPrice> = Object.create(null);
    Object.assign(merged, BUILTIN_PRICE_TABLE.prices);
    for (const [model, entry] of Object.entries(
      rawPrices as Record<string, unknown>,
    )) {
      const price = coercePrice(entry);
      if (price) merged[model] = price;
    }
    return {
      _meta: { ...BUILTIN_PRICE_TABLE._meta, _override: overridePath },
      prices: merged,
    };
  } catch {
    // Malformed / unreadable override → fail open to the built-in table.
    return BUILTIN_PRICE_TABLE;
  }
}

/** Price for one model, or undefined if the table does not list it. */
export function priceFor(
  model: string,
  table: PriceTable = loadPriceTable(),
): ModelPrice | undefined {
  // Own-property lookup only. A user-controlled model id that collides with an
  // Object.prototype key ("__proto__", "constructor", "valueOf", "toString", …)
  // must resolve to undefined (unpriced → fail open), NOT to an inherited
  // prototype member — otherwise costUsd would compute on a function and return
  // NaN, silently poisoning the USD budget (a prototype-walk bug class this
  // codebase has been bitten by before — use Object.hasOwn, never `in`/bracket).
  return Object.hasOwn(table.prices, model) ? table.prices[model] : undefined;
}

/**
 * USD cost of a call given its token usage, or `undefined` when the model is
 * not priced (fail-open: the budget layer then declines to enforce on it).
 */
export function costUsd(
  model: string,
  usage: { inputTokens: number; outputTokens: number },
  table: PriceTable = loadPriceTable(),
): number | undefined {
  const price = priceFor(model, table);
  if (!price) return undefined;
  return (
    (usage.inputTokens / 1_000_000) * price.input +
    (usage.outputTokens / 1_000_000) * price.output
  );
}

/**
 * True when the table's `_generatedAt` is unparseable, in the future, or older
 * than `maxAgeDays` (default 548 ≈ 18 months). Pure — caller supplies `now` —
 * so a scheduled job can fail loudly without baking a wall-clock time-bomb into
 * every PR's test run.
 */
export function isPriceTableStale(
  generatedAt: string,
  now: number,
  maxAgeDays = 548,
): boolean {
  const t = Date.parse(generatedAt);
  if (Number.isNaN(t)) return true;
  if (t > now) return true;
  return now - t > maxAgeDays * MS_PER_DAY;
}
