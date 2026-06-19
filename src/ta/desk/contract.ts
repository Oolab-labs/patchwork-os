/**
 * contract.ts — assemble the FLAT payload + THREE asserts that ABORT loudly.
 *
 *   (a) JSON.stringify(payload).length < 7000
 *   (b) every numbersIndex token is provenance-backed
 *   (c) no banned field/token name present
 *
 * The code guarantee is the real moat boundary: a faithful LLM narrating a
 * dishonest JSON would pass a byte-present judge, so the JSON must be honest by
 * construction. On total feed failure this still produces a fully-degraded
 * payload (surfaces become 'feed offline' lines; posture forced 'Standing
 * aside').
 */

import type { Verdict } from "./cellBacktest.js";
import type { LedgerSummary } from "./deskLedger.js";
import type { LiqTapeSummary } from "./liqTape.js";
import {
  renderAtlas,
  renderBtcDna,
  renderDepth,
  renderFeedHealth,
  renderLedger,
  renderLiqGeometry,
  renderLiqTape,
  renderMaxPain,
  renderNav,
  renderRektShield,
  renderTodaysRead,
} from "./render.js";
import {
  computeAtlas,
  computeBtcDna,
  computeIchimokuLocation,
  computeRektShield,
  computeTodaysRead,
  depthSurface,
  liqGeometrySurface,
  maxPainSurface,
  stopVsBand,
} from "./surfaces.js";
import type {
  Collected,
  QumoPayload,
  QumoTrade,
  SurfaceFragment,
} from "./types.js";
import {
  ALLOWED_POSTURES,
  BANNED_CLAIM_VOCAB,
  BANNED_TOKENS,
  narratedNumbers,
  PAYLOAD_BYTE_BUDGET,
  SCHEMA_VERSION,
} from "./types.js";

export class ContractError extends Error {}

export interface AssembleInput {
  feeds: Collected;
  trade: QumoTrade | null;
  ledger: LedgerSummary;
  /** tri-count from live ledger files (open/graded). */
  tri: { nRisk: number; nWatch: number; nConfirm: number };
  nowMs: number;
  /** whether the ledger summary was a cached/degraded read. */
  cachedLedger: boolean;
  /** Latest verdicts from cellBacktest.ts kill-gate battery (optional). */
  verdicts?: Map<string, Verdict>;
  /** Live liq tape summary from resident collector (optional). */
  liqTape?: LiqTapeSummary | null;
}

/** Build the flat payload and run the three asserts before returning it. */
export function assemblePayload(input: AssembleInput): QumoPayload {
  const { feeds, trade, ledger, tri, nowMs, cachedLedger, verdicts, liqTape } =
    input;

  const todaysRead = computeTodaysRead(feeds, tri);
  const rekt = computeRektShield(trade, nowMs);
  const dna = computeBtcDna(feeds);
  const ichi = computeIchimokuLocation(feeds.btc1d.value);
  const atlas = computeAtlas(feeds.atlas.value);
  const depth = depthSurface(feeds.depth.value);
  const maxPain = maxPainSurface(feeds.options.value, nowMs);

  // Modeled liq geometry — NO new fetch. mid = order-book depth mid; fall back to
  // the latest BTC 1d close when depth is offline. OI $ = latest perp-OI notional
  // (reused from the openInterestHist fetch). Pure leverage-bucket arithmetic.
  const btcCandles = feeds.btc1d.value;
  const lastClose =
    btcCandles && btcCandles.length > 0
      ? btcCandles[btcCandles.length - 1]?.close
      : null;
  const geoMid =
    typeof depth.mid === "number" ? depth.mid : (lastClose ?? null);
  const liqGeo = liqGeometrySurface(geoMid, feeds.oiNotional.value);
  const stopBand = stopVsBand(trade, liqGeo);

  const todaysReadFrag = renderTodaysRead(todaysRead);
  const rektFrag = renderRektShield(rekt, stopBand);
  const dnaFrag = renderBtcDna(dna, ichi);
  const atlasFrag = renderAtlas(atlas);
  const depthFrag = renderDepth(depth);
  const maxPainFrag = renderMaxPain(maxPain);
  const liqGeoFrag = renderLiqGeometry(liqGeo);
  const ledgerFrag = renderLedger(
    ledger,
    cachedLedger ? ledger.asOf : null,
    verdicts,
  );
  const liqTapeFrag = liqTape ? renderLiqTape(liqTape) : null;
  const engineHealthy = feeds.btc1d.state === "live";
  const navFrag = renderNav(engineHealthy);

  // asOfData = newest live datum across collectors.
  const asOfs = [
    feeds.btc1d.asOf,
    feeds.btc24hPct.asOf,
    feeds.funding.asOf,
    feeds.atlas.asOf,
    feeds.feargreed.asOf,
  ].filter((x): x is string => typeof x === "string");
  const asOfData =
    asOfs.length > 0
      ? asOfs.sort().slice(-1)[0]!
      : new Date(nowMs).toISOString();

  const frags: SurfaceFragment[] = [
    todaysReadFrag,
    rektFrag,
    dnaFrag,
    atlasFrag,
    depthFrag,
    maxPainFrag,
    liqGeoFrag,
    ledgerFrag,
    navFrag,
  ];
  if (liqTapeFrag) frags.push(liqTapeFrag);

  // numbersIndex — dedup, preserve order, newline-joined. Dates/schemaVersion
  // are NOT fragment numbers so they never enter here.
  const seen = new Set<string>();
  const indexLines: string[] = [];
  for (const frag of frags) {
    for (const nt of frag.numbers) {
      if (seen.has(nt.token)) continue;
      seen.add(nt.token);
      indexLines.push(nt.token);
    }
  }
  const numbersIndex = indexLines.join("\n");

  const payload: QumoPayload = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    asOfData,
    feedHealthMd: renderFeedHealth(feeds),
    allowedPostures: ALLOWED_POSTURES.join(" | "),
    todaysReadMd: todaysReadFrag.md,
    rektShieldMd: rektFrag.md,
    btcDnaMd: dnaFrag.md,
    atlasMd: atlasFrag.md,
    depthMd: depthFrag.md,
    maxPainMd: maxPainFrag.md,
    liqGeoMd: liqGeoFrag.md,
    ...(liqTapeFrag ? { liqTapeMd: liqTapeFrag.md } : {}),
    ledgerMd: ledgerFrag.md,
    navMd: navFrag.md,
    numbersIndex,
  };

  assertContract(payload, frags);
  return payload;
}

/**
 * The THREE asserts. Throws ContractError (loud abort) on any failure.
 * Exported so the build-failing unit test can call it directly.
 */
export function assertContract(
  payload: QumoPayload,
  frags: SurfaceFragment[],
): void {
  // (a) byte budget
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf-8");
  if (bytes >= PAYLOAD_BYTE_BUDGET) {
    throw new ContractError(
      `payload ${bytes} bytes >= ${PAYLOAD_BYTE_BUDGET} budget — aborting POST`,
    );
  }

  // The user-facing markdown surfaces — every banned claim word in these must
  // co-locate a closed/location label (check c).
  const surfaceFields = [
    payload.feedHealthMd,
    payload.allowedPostures,
    payload.todaysReadMd,
    payload.rektShieldMd,
    payload.btcDnaMd,
    payload.atlasMd,
    payload.depthMd,
    payload.maxPainMd,
    payload.liqGeoMd,
    payload.ledgerMd,
    payload.navMd,
  ];

  // The NARRATIVE FACT surfaces — the subset whose printed numbers are claims of
  // fact the engine fully controls, so each MUST trace to numbersIndex (b2).
  // EXCLUDED:
  //   - feedHealthMd / allowedPostures: digits are structural identifiers
  //     (feed names like "binance24h", posture vocab like "Watching X").
  //   - atlasMd: its only numeric CLAIMS are the per-sector change24hPct values,
  //     already provenance-backed by check (b); its sector NAMES come verbatim
  //     from the live CoinGecko feed ("Layer 1", "Web3") and carry unpredictable
  //     identifier digits the engine cannot pre-register. narratedNumbers()
  //     strips glued identifiers (L1/Web3) but a SPACE-separated name ("Layer 1")
  //     still yields a bare digit — not a claim, so atlas is guard-exempt.
  const factSurfaces = [
    payload.todaysReadMd,
    payload.rektShieldMd,
    payload.btcDnaMd,
    payload.depthMd,
    payload.maxPainMd,
    payload.liqGeoMd,
    payload.ledgerMd,
    payload.navMd,
    ...(payload.liqTapeMd ? [payload.liqTapeMd] : []),
  ];

  // (b) every numbersIndex token is provenance-backed (index → provenance)
  const backed = new Set<string>();
  for (const frag of frags) {
    for (const nt of frag.numbers) {
      if (!nt.provenance) {
        throw new ContractError(
          `numbersIndex token "${nt.token}" has no provenance`,
        );
      }
      backed.add(nt.token);
    }
  }
  for (const token of payload.numbersIndex.split("\n").filter(Boolean)) {
    if (!backed.has(token)) {
      throw new ContractError(
        `numbersIndex token "${token}" is not provenance-backed`,
      );
    }
  }

  // (c) no banned field/token NAME present anywhere in the payload.
  // Match as a whole identifier token, NOT a substring — otherwise the English
  // word "graded" (a legitimate ledger state) trips the "grade" ban, and
  // "upgrade" would too. Banned names are field identifiers; bound them by
  // non-alphanumeric edges so prose words are not false-positives.
  const haystack = JSON.stringify(payload);
  for (const banned of BANNED_TOKENS) {
    const re = new RegExp(`(^|[^a-zA-Z])${banned}([^a-zA-Z]|$)`, "i");
    if (re.test(haystack)) {
      throw new ContractError(
        `banned token name "${banned}" present in payload`,
      );
    }
  }
  // Falsified claim vocab is allowed ONLY in the audit-view rendering of the
  // ledger ("ichimoku family ... closed"); banned as a positive lean elsewhere.
  // We assert the family name never appears OUTSIDE the explicit closed-label
  // context. Simplest honest rule: the only legal occurrences carry the word
  // "closed" alongside. Enforce by requiring every occurrence to co-locate.
  // (surfaceFields declared above — reused here.)
  for (const vocab of BANNED_CLAIM_VOCAB) {
    const v = vocab.toLowerCase();
    if (!haystack.toLowerCase().includes(v)) continue;
    // every surface field mentioning the banned vocab must co-locate an
    // explicit "closed" or "location" audit label — else it is a live claim.
    const mentioning = surfaceFields.filter((md) =>
      md.toLowerCase().includes(v),
    );
    for (const md of mentioning) {
      const lower = md.toLowerCase();
      if (!lower.includes("closed") && !lower.includes("location")) {
        throw new ContractError(
          `banned claim vocab "${vocab}" present without closed/location label`,
        );
      }
    }
  }

  // (d) BIDIRECTIONAL number trace — every PRINTED number in the fact surfaces
  // is in numbersIndex (the complement of check (b), which only verifies the
  // other direction). Closes the leak class where a surface narrates a number
  // — e.g. the Deribit DDMMMYY expiry's embedded 27/26 — that was never
  // registered. narratedNumbers() strips the date/time + identifier exempt
  // classes first. Runs LAST so the categorical banned-NAME/vocab violations
  // (b,c) surface ahead of this finer-grained trace check.
  const indexed = new Set(payload.numbersIndex.split("\n").filter(Boolean));
  for (const md of factSurfaces) {
    for (const token of narratedNumbers(md)) {
      if (!indexed.has(token)) {
        throw new ContractError(
          `narrated number "${token}" is not in numbersIndex (printed but un-indexed) — surface: ${md.slice(0, 60)}…`,
        );
      }
    }
  }
}

/**
 * A fully-degraded payload for total feed failure (still POSTed). Routed
 * through assertContract so the static prose can never silently drift to
 * narrate a number outside its index or a banned name — the provenance
 * round-trip holds on the exact path (total feed failure) where it matters most.
 */
export function degradedPayload(nowMs: number): QumoPayload {
  const payload = buildDegradedPayload(nowMs);
  // The degraded numbersIndex tokens, each provenance-backed by construction.
  const frags: SurfaceFragment[] = [
    {
      md: "degraded",
      numbers: payload.numbersIndex
        .split("\n")
        .filter(Boolean)
        .map((token) => ({
          token,
          provenance:
            token === "-0.53" ? ("matured-ledger" as const) : ("det" as const),
        })),
    },
  ];
  assertContract(payload, frags);
  return payload;
}

function buildDegradedPayload(nowMs: number): QumoPayload {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    asOfData: new Date(nowMs).toISOString(),
    feedHealthMd:
      "binanceSpot: offline · binance24h: offline · binanceFutures: offline · coingecko: offline · feargreed: offline · orderbookDepth: offline · deribitOptions: offline · liqMap: offline-paid · etfFlows: offline-paid · whale: offline-paid · bybitCrossVenue: offline-deferred",
    allowedPostures: ALLOWED_POSTURES.join(" | "),
    todaysReadMd:
      "**Desk posture: Standing aside.** Reason: all market feeds offline — no read. Tri-count — risk 0 / watch 0 / confirm 0 (no live ledger files reachable). Breadth — feed offline.",
    rektShieldMd:
      "No hypothetical trade supplied — Rekt Shield idle. (Risk math is feed-independent; it activates only on a supplied trade.)",
    btcDnaMd:
      "Trend: feed offline. Funding-stress: feed offline. Spot-confirm: feed offline. Leverage: feed offline. Whale: pending — feed offline. Liquidity-trap: pending — liq-map paid. ETF: pending — paid. Location (no edge): Ichimoku location unavailable. Ichimoku family closed 2026-06-11 — location context, not a signal. Coverage: 0 of 7 strands live, 7 pending/offline.",
    atlasMd: "Atlas offline — sector feed unavailable.",
    depthMd: "Order book: feed offline.",
    maxPainMd: "Deribit options: feed offline.",
    liqGeoMd: "Liq geometry: feed offline — mid or OI unavailable.",
    ledgerMd:
      "LEDGER (history, not a forward probability). No fresh ledger summary reachable. FALSIFIED/BANNED (audit): wp-level-fifty @4h edge -0.53 — falsified. ichimoku-family @1d — closed 2026-06-11. Live signal audit: 0 open claims, 0 graded.",
    navMd:
      "Read Market → Find Setups → Confirm → Assess/Protect Risk → Review proof. Terminal: Stand Aside. Engine: waiting — awaiting cron data.",
    numbersIndex: ["0", "7", "-0.53"].join("\n"),
  };
}
