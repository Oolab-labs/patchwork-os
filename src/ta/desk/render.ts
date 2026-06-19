/**
 * render.ts — each surface's facts → a COMPACT markdown-fragment STRING, plus
 * the numbersIndex (newline-joined every numeric token emitted; dates +
 * schemaVersion exempt). The render layer is where every printed number is
 * registered so the contract assert + the sonnet judge can grep it.
 *
 * NEVER renders a probability / composite / target. Ichimoku renders ONLY as a
 * no-edge LOCATION line with the explicit closed-family label (user decision 1).
 */

import type { Verdict } from "./cellBacktest.js";
import type { LedgerSummary } from "./deskLedger.js";
import type {
  AtlasFacts,
  DepthFacts,
  DnaFacts,
  IchimokuLocation,
  LiqGeoFacts,
  MaxPainFacts,
  RektFacts,
  StopBandFact,
  TodaysReadFacts,
} from "./surfaces.js";
import { fmtSigned, LIQ_CONTESTED_PCT, LIQ_WIDE_PCT } from "./surfaces.js";
import type { Collected, FeedState, SurfaceFragment } from "./types.js";

/** Collect numeric tokens; helper keeps the numbersIndex consistent. */
function nums(...tokens: (number | null | undefined)[]): string[] {
  return tokens
    .filter((t): t is number => typeof t === "number" && Number.isFinite(t))
    .map((t) => String(t));
}

// ── FEED HEALTH ──────────────────────────────────────────────────────────────

const PAID_FEEDS =
  "liqMap: offline-paid · etfFlows: offline-paid · whale: offline-paid";

export function renderFeedHealth(feeds: Collected): string {
  const s = (st: FeedState) => st;
  return [
    `binanceSpot: ${s(feeds.btc1d.state)}`,
    `binance24h: ${s(feeds.btc24hPct.state)}`,
    `binanceFutures: ${s(feeds.funding.state)}`,
    `coingecko: ${s(feeds.atlas.state)}`,
    `feargreed: ${s(feeds.feargreed.state)}`,
    `orderbookDepth: ${s(feeds.depth.state)}`,
    `deribitOptions: ${s(feeds.options.state)}`,
    PAID_FEEDS,
    "bybitCrossVenue: offline-deferred",
  ].join(" · ");
}

// ── TODAY'S READ ─────────────────────────────────────────────────────────────

export function renderTodaysRead(f: TodaysReadFacts): SurfaceFragment {
  const breadth =
    f.universeN === null
      ? "Breadth — feed offline."
      : `Breadth — ${f.nGreen} green / ${f.nRed} red of ${f.universeN} tracked.`;
  const md =
    `**Desk posture: ${f.posture}.** Reason: ${f.reason}. ` +
    `Tri-count — risk ${f.nRisk} / watch ${f.nWatch} / confirm ${f.nConfirm} (own live ledger files). ` +
    breadth;
  return {
    md,
    numbers: nums(
      f.nRisk,
      f.nWatch,
      f.nConfirm,
      f.nGreen,
      f.nRed,
      f.universeN,
    ).map((token) => ({ token, provenance: "det" as const })),
  };
}

// ── REKT SHIELD ──────────────────────────────────────────────────────────────

export function renderRektShield(
  f: RektFacts,
  stopBand?: StopBandFact | null,
): SurfaceFragment {
  if (f.idle) {
    return {
      md: "No hypothetical trade supplied — Rekt Shield idle. (Risk math is feed-independent; it activates only on a supplied trade.)",
      numbers: [],
    };
  }
  const rule = `rule: WIDE >${LIQ_WIDE_PCT}% · NEAR ${LIQ_CONTESTED_PCT}-${LIQ_WIDE_PCT}% · CONTESTED <${LIQ_CONTESTED_PCT}%, rendered inline`;
  // Structural stop-vs-band line — pure location ("sits within / clear of"), NO
  // recommendation, NO "move your stop", NO forecast. Added ONLY when a trade is
  // supplied AND modeled geometry is available; omitted otherwise (idle handled
  // above; geometry-offline → stopBand null → line omitted).
  let stopLine = "";
  const extraTokens: number[] = [];
  if (stopBand) {
    const rel = stopBand.within ? `within ~${stopBand.pct}% of` : "clear of";
    stopLine = ` Stop ${f.stop} sits ${rel} the modeled ${stopBand.n}x ${stopBand.side}-liq band ~${stopBand.bandPrice} (structure, not a recommendation).`;
    if (typeof f.stop === "number") extraTokens.push(f.stop);
    extraTokens.push(stopBand.pct, stopBand.bandPrice, stopBand.n);
  }
  const md =
    `Liq price ${f.liqPrice}. Liq distance ${f.liqDistancePct}%. ` +
    `R:R ${f.rrRatio}:1 (risk leg ${f.riskLegPct}% / reward leg ${f.rewardLegPct}%). ` +
    `Capital at risk ${f.capitalAtRiskPct}%. ` +
    `Liq-distance posture: ${f.liqPosture} (${rule}). ` +
    `R reference — bookkeeping, not a target. Claim logged, graded at ${f.gradeAt}.` +
    stopLine +
    "\nWhat today does not license: new entries / adds / leverage.";
  return {
    md,
    numbers: nums(
      f.liqPrice,
      f.liqDistancePct,
      f.rrRatio,
      f.riskLegPct,
      f.rewardLegPct,
      f.capitalAtRiskPct,
      LIQ_WIDE_PCT,
      LIQ_CONTESTED_PCT,
      ...extraTokens,
    ).map((token) => ({ token, provenance: "det" as const })),
  };
}

// ── BTC DNA ──────────────────────────────────────────────────────────────────

export function renderBtcDna(
  dna: DnaFacts,
  ichi: IchimokuLocation,
): SurfaceFragment {
  const trend = dna.trend.live
    ? `Trend: 24h ${fmtSigned(dna.trend.pct as number)}% — ${dna.trend.lean}.`
    : "Trend: feed offline.";
  const funding = dna.funding.live
    ? `Funding-stress: ${fmtSigned(dna.funding.pct as number)}% (${(dna.funding.pct as number) < 0 ? "shorts pay" : "longs pay"}) — archived, not read (funding claim type not matured).`
    : "Funding-stress: feed offline.";
  const spot = dna.spotConfirm.live
    ? `Spot-confirm: taker buy ${dna.spotConfirm.pct}% — archived, not read (no validated edge).`
    : "Spot-confirm: feed offline.";
  const lev = dna.leverage.live
    ? `Leverage: crowd ${dna.leverage.crowdPct}% long, OI ${fmtSigned(dna.leverage.oiPct ?? 0)}% — archived, not read.`
    : "Leverage: feed offline.";

  // Ichimoku — NO-EDGE LOCATION CONTEXT ONLY. Location line + explicit label.
  let ichiLine: string;
  if (ichi.available) {
    const loc = ichi.cloud === "in" ? "in the cloud" : `${ichi.cloud} cloud`;
    const tk =
      ichi.tkCrossBarsAgo === null || ichi.tkCrossBarsAgo === undefined
        ? "no TK cross in range"
        : `TK cross ${ichi.tkCrossBarsAgo} bars ago`;
    ichiLine = `Location (no edge): price ${loc}; ${tk}. Ichimoku family closed 2026-06-11 — location context, not a signal.`;
  } else {
    ichiLine =
      "Location (no edge): Ichimoku location unavailable. Ichimoku family closed 2026-06-11 — location context, not a signal.";
  }

  const md = [
    trend,
    funding,
    spot,
    lev,
    "Whale: pending — feed offline. Liquidity-trap: pending — liq-map paid. ETF: pending — paid.",
    ichiLine,
    `Coverage: ${dna.liveCount} of 7 strands live, ${7 - dna.liveCount} pending/archived.`,
  ].join(" ");

  // numbersIndex: trend% (live-feed), coverage counts (det). Funding/positioning
  // values ARE printed → must be indexed so the judge can grep them, but they
  // are archived facts (live-feed provenance). Ichimoku bars-ago is a LOCATION,
  // NOT a tradeable claim → still indexed so the judge accepts it when printed.
  const tokens: { token: string; provenance: "det" | "live-feed" }[] = [];
  if (dna.trend.live && dna.trend.pct !== null) {
    tokens.push({ token: String(dna.trend.pct), provenance: "live-feed" });
  }
  if (dna.funding.live && dna.funding.pct !== null) {
    tokens.push({ token: String(dna.funding.pct), provenance: "live-feed" });
  }
  if (dna.spotConfirm.live && dna.spotConfirm.pct !== null) {
    tokens.push({
      token: String(dna.spotConfirm.pct),
      provenance: "live-feed",
    });
  }
  if (dna.leverage.live) {
    if (dna.leverage.crowdPct !== null)
      tokens.push({
        token: String(dna.leverage.crowdPct),
        provenance: "live-feed",
      });
    if (dna.leverage.oiPct !== null)
      tokens.push({
        token: String(dna.leverage.oiPct),
        provenance: "live-feed",
      });
  }
  if (ichi.available && typeof ichi.tkCrossBarsAgo === "number") {
    tokens.push({ token: String(ichi.tkCrossBarsAgo), provenance: "det" });
  }
  tokens.push({ token: String(dna.liveCount), provenance: "det" });
  tokens.push({ token: String(7 - dna.liveCount), provenance: "det" });
  tokens.push({ token: "7", provenance: "det" });
  return { md, numbers: tokens };
}

// ── ATLAS ────────────────────────────────────────────────────────────────────

export function renderAtlas(a: AtlasFacts): SurfaceFragment {
  if (!a.available) {
    return { md: "Atlas offline — sector feed unavailable.", numbers: [] };
  }
  const parts = a.sectors.map((s) => {
    const lead = s.leaders.length ? ` (leaders ${s.leaders.join(", ")})` : "";
    return `${s.name} ${fmtSigned(s.change24hPct)}%${lead}`;
  });
  const md =
    `Sector 24h market-cap change (realized): ${parts.join("; ")}. ` +
    `24h-change location: leaders ${a.leaders.join("/")}, laggards ${a.laggards.join("/")}. ` +
    "No edge — rotation location only, 24h window.";
  return {
    md,
    numbers: a.sectors.map((s) => ({
      token: String(s.change24hPct),
      provenance: "live-feed" as const,
    })),
  };
}

// ── LEDGER ───────────────────────────────────────────────────────────────────

export function renderLedger(
  s: LedgerSummary,
  cachedAsOf: string | null,
  verdicts?: Map<string, Verdict>,
): SurfaceFragment {
  const tokens: { token: string; provenance: "det" | "matured-ledger" }[] = [];
  const graded: string[] = [];
  const watch: string[] = [];
  const audit: string[] = [];

  for (const c of s.cells) {
    if (c.status === "GRADED") {
      const pPart = c.permutationP !== undefined ? `, p=${c.permutationP}` : "";
      const maturedShown = c.matured ?? c.decided;
      const scorableShown = c.scorable ?? c.decided;
      graded.push(
        `${c.type} @${c.timeframe}: matured ${maturedShown}, scorable ${scorableShown}, holds ${c.holds ?? "?"}, holdRate ${c.holdRate} vs baseline ${c.baselineRate}, edge ${fmtSign(c.edge)}${pPart} (N inline).`,
      );
      for (const t of [
        maturedShown,
        scorableShown,
        c.holds,
        c.holdRate,
        c.baselineRate,
        c.edge,
        c.permutationP,
      ]) {
        if (typeof t === "number")
          tokens.push({ token: String(t), provenance: "matured-ledger" });
      }
    } else if (c.status === "WATCH") {
      watch.push(
        `${c.type} @${c.timeframe}: kill-gate ${c.decided ?? 0}/${c.gate ?? 40} decided per arm — accumulating, no test run.`,
      );
      if (typeof c.decided === "number")
        tokens.push({ token: String(c.decided), provenance: "det" });
      if (typeof c.gate === "number")
        tokens.push({ token: String(c.gate), provenance: "det" });
    } else {
      // FALSIFIED / BANNED / PENDING — audit view, by name.
      const e = c.edge !== undefined ? ` edge ${fmtSign(c.edge)}` : "";
      audit.push(
        `${c.type} @${c.timeframe}${e} — ${c.note ?? c.status.toLowerCase()}.`,
      );
      if (typeof c.edge === "number")
        tokens.push({ token: String(c.edge), provenance: "matured-ledger" });
    }
  }

  // Verdict-based cells (kill-gate battery: wp-volume-climax and future cells).
  // These cells are managed by cellBacktest.ts and never flow through deskLedger.ts.
  if (verdicts && verdicts.size > 0) {
    for (const [cellName, v] of verdicts) {
      const tf = v.timeframe ?? "1d"; // older verdicts pre-date timeframe field
      const n100 = Math.round(v.methodWinRate * 1000) / 10; // win-rate % to 1dp
      const lo100 = Math.round(v.wilsonLow * 1000) / 10;
      const hi100 = Math.round(v.wilsonHigh * 1000) / 10;
      // edge100: the edge as a %-string — MUST match exactly what edgeFmt emits
      // after narratedNumbers strips the leading '+'. Registered as a token so
      // the bidirectional contract guard can find it.
      const edge100 = (v.edge * 100).toFixed(1); // e.g. "7.0", "-5.0"
      const edgeFmt = `${v.edge >= 0 ? "+" : ""}${edge100}%`;
      if (v.gateState === "GRADED") {
        // Hash guard: a GRADED verdict whose candle set has since been refreshed
        // must not display as GRADED until --gate is re-run. The engine writes a
        // snapshot hash alongside the verdict; compare here.
        const hashMatch = v.candleSetHash != null; // placeholder until Phase 3 snapshot wiring
        const label = hashMatch
          ? "GRADED"
          : "GRADED (re-gate-pending: cache updated)";
        graded.push(
          `${cellName} @${tf}: ${label} — N=${v.N}, win-rate ${n100}% [${lo100}–${hi100}% Wilson], edge ${edgeFmt}, p=${v.permutationP.toFixed(3)} (family-adj ${v.familyAdjustedP.toFixed(3)}).`,
        );
        for (const t of [
          String(v.N),
          String(n100),
          String(lo100),
          String(hi100),
          String(edge100),
          v.permutationP.toFixed(3),
          v.familyAdjustedP.toFixed(3),
        ]) {
          tokens.push({ token: t, provenance: "matured-ledger" });
        }
      } else if (v.gateState === "WATCH") {
        watch.push(
          `${cellName} @${tf}: N=${v.N} decided, win-rate ${n100}% [${lo100}–${hi100}% Wilson], edge ${edgeFmt}, p=${v.permutationP.toFixed(3)} — gate not reached.`,
        );
        for (const t of [
          String(v.N),
          String(n100),
          String(lo100),
          String(hi100),
          String(edge100),
          v.permutationP.toFixed(3),
        ]) {
          tokens.push({ token: t, provenance: "det" });
        }
      } else {
        // FALSIFIED
        audit.push(
          `${cellName} @${tf}: FALSIFIED — N=${v.N}, edge ${edgeFmt}.`,
        );
        for (const t of [String(v.N), String(edge100)]) {
          tokens.push({ token: t, provenance: "matured-ledger" });
        }
      }
    }
  }

  const cachedNote = cachedAsOf
    ? ` No fresh ledger summary reachable — showing last matured summary as of ${cachedAsOf}.`
    : "";
  const md =
    "LEDGER (history, not a forward probability)." +
    cachedNote +
    (graded.length ? ` ${graded.join(" ")}` : "") +
    (watch.length ? ` ${watch.join(" ")}` : "") +
    ` FALSIFIED/BANNED (audit): ${audit.join(" ")}` +
    ` Live signal audit: ${s.openClaims} open claims, ${s.gradedClaims} graded.`;
  tokens.push({ token: String(s.openClaims), provenance: "det" });
  tokens.push({ token: String(s.gradedClaims), provenance: "det" });
  return { md, numbers: tokens };
}

// ── ORDER-BOOK DEPTH ─────────────────────────────────────────────────────────

export function renderDepth(f: DepthFacts): SurfaceFragment {
  if (!f.available) {
    return { md: "Order book: feed offline.", numbers: [] };
  }
  const thin = f.thinZone
    ? `Thin zone ${f.thinLo}–${f.thinHi}. `
    : "Thin zone: none material (dense book). ";
  const md =
    `Mid ${f.mid}. Bid depth ±1% $${f.bid1Pct}m / ask $${f.ask1Pct}m (±2% bid $${f.bid2Pct}m / ask $${f.ask2Pct}m); book skew ${f.skew}. ` +
    `Nearest bid wall ${f.bidWallPrice} ($${f.bidWallUsd}m), ask wall ${f.askWallPrice} ($${f.askWallUsd}m). ` +
    thin +
    "Structure/location only — no direction, no target.";
  const tokens = nums(
    f.mid,
    f.bid1Pct,
    f.ask1Pct,
    f.bid2Pct,
    f.ask2Pct,
    f.bidWallPrice,
    f.bidWallUsd,
    f.askWallPrice,
    f.askWallUsd,
    // band-label literals "±1%/±2%" are narrated → register so a grep judge
    // never flags them as un-indexed (mirrors the "7 strands" pattern).
    1,
    2,
  );
  if (f.thinZone) tokens.push(...nums(f.thinLo, f.thinHi));
  return {
    md,
    numbers: tokens.map((token) => ({ token, provenance: "det" as const })),
  };
}

// ── OPTIONS MAX-PAIN ─────────────────────────────────────────────────────────

export function renderMaxPain(f: MaxPainFacts): SurfaceFragment {
  if (!f.available) {
    return { md: "Deribit options: feed offline.", numbers: [] };
  }
  // Narrate the front expiry as a canonical ISO date (date-exempt), NEVER the
  // raw Deribit DDMMMYY token — that token embeds bare digits (e.g. 27, 26) that
  // are not deterministic facts on the index spine and would leak as un-indexed
  // narrated numbers. The ISO date is the ONLY machine-exempt number class.
  const md =
    `Deribit BTC expiry ${f.expiryIso} max-pain strike ${f.maxPainStrike} (OI-weighted, intrinsic-min); ` +
    `put/call OI ${f.putCallRatio}; total option OI ${f.totalOi} BTC. ` +
    "Label: max-pain is an OI snapshot — location context only, not a price magnet. No directional claim.";
  return {
    md,
    numbers: nums(f.maxPainStrike, f.putCallRatio, f.totalOi).map((token) => ({
      token,
      provenance: "det" as const,
    })),
  };
}

// ── MODELED LIQUIDATION GEOMETRY — leverage-bucket location (NOT a forecast) ──

export function renderLiqGeometry(f: LiqGeoFacts): SurfaceFragment {
  if (!f.available || !f.bands || typeof f.mid !== "number") {
    return {
      md: "Liq geometry: feed offline — mid or OI unavailable.",
      numbers: [],
    };
  }
  const longBands = f.bands.map((b) => `${b.n}x~${b.longLiq}`).join(" · ");
  const shortBands = f.bands.map((b) => `${b.n}x~${b.shortLiq}`).join(" · ");
  // OI $ → whole millions (scale-unit suffix; narratedNumbers keeps the digit as
  // a fact so the millions integer must be indexed). null → "unavailable".
  const oiMillions =
    typeof f.oiNotional === "number"
      ? Math.round(f.oiNotional / 1_000_000)
      : null;
  const oiPart =
    oiMillions !== null
      ? `Total perp OI $${oiMillions}m. `
      : "Total perp OI: unavailable. ";
  const md =
    `Modeled liq geometry from mid ${f.mid} (leverage buckets, NOT exchange position data): ` +
    `long-liq bands ${longBands}; short-liq bands ${shortBands}. ` +
    oiPart +
    "Geometry estimate only — not a forecast, not a magnet, no claim price moves to these; assumes positions near mid. Location read, like order-book walls.";
  const tokens = nums(
    f.mid,
    ...f.bands.map((b) => b.longLiq),
    ...f.bands.map((b) => b.shortLiq),
  );
  if (oiMillions !== null) tokens.push(String(oiMillions));
  return {
    md,
    numbers: tokens.map((token) => ({ token, provenance: "det" as const })),
  };
}

// ── NAV ──────────────────────────────────────────────────────────────────────

export function renderNav(engineHealthy: boolean): SurfaceFragment {
  const eng = engineHealthy
    ? "Engine: live native."
    : "Engine: waiting — awaiting cron data.";
  return {
    md: `Read Market → Find Setups → Confirm → Assess/Protect Risk → Review proof. Terminal: Stand Aside. ${eng}`,
    numbers: [],
  };
}

// ── LIQUIDATION TAPE ─────────────────────────────────────────────────────────

import type { LiqTapeSummary } from "./liqTape.js";

export function renderLiqTape(s: LiqTapeSummary): SurfaceFragment {
  const longB = (s.totalLongUsd / 1e9).toFixed(2); // billions to 2dp
  const shortB = (s.totalShortUsd / 1e9).toFixed(2);
  const skew =
    s.totalLongUsd + s.totalShortUsd > 0
      ? ((s.totalLongUsd / (s.totalLongUsd + s.totalShortUsd)) * 100).toFixed(1)
      : "50.0";

  const topParts = s.topSymbols.map((t) => {
    const totalB = ((t.longUsd + t.shortUsd) / 1e9).toFixed(2);
    return `${t.sym} $${totalB}B`;
  });

  const md =
    `Liq tape (realized, ${s.windowHours}h): long $${longB}B (${s.longCount} events) / short $${shortB}B (${s.shortCount} events). ` +
    `Long-liquidation share ${skew}%. ` +
    `Top by volume: ${topParts.join(", ")}. ` +
    "Realized data only — not a forecast, not a magnet.";

  const tokens = [
    longB,
    shortB,
    skew,
    ...s.topSymbols.map((t) => ((t.longUsd + t.shortUsd) / 1e9).toFixed(2)),
  ];
  // counts and windowHours are structural det values
  tokens.push(String(s.longCount), String(s.shortCount), String(s.windowHours));

  return {
    md,
    numbers: tokens.map((t) => ({ token: t, provenance: "det" as const })),
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtSign(n?: number): string {
  if (typeof n !== "number") return "?";
  return n > 0 ? `+${n}` : `${n}`;
}
