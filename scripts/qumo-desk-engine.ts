/**
 * qumo-desk-engine.ts — off-box engine CLI for the QUMO-style Honest Desk.
 *
 *   npx tsx scripts/qumo-desk-engine.ts            # compute + POST
 *   npx tsx scripts/qumo-desk-engine.ts --dry-run  # compute + print payload + bytes, NO post
 *   npx tsx scripts/qumo-desk-engine.ts --backtest # nightly ledger rerun (rewrites summary)
 *
 * Runs on the local Mac only (the VPS has no crypto tools + POST-only http).
 * Reuses src/recipes/tools/market.ts endpoints (via collectors.ts), detectSwings,
 * scoreLedger, the altsetup-killgate paired-dartboard pattern. Reads the watched
 * trade file ~/.patchwork/qumo-trade.json if present for Rekt Shield.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  emitTodayCards,
  registerDetector,
  startupCheck,
} from "../src/ta/desk/accrualEmitter.js";
import {
  appendVerdict,
  readLatestVerdicts,
} from "../src/ta/desk/cellBacktest.js";
import {
  wpMaRejectionDetector,
  wpMaRejectionSpec,
} from "../src/ta/desk/cells/wpMaRejection.js";
import {
  FAMILY_N,
  wpVolumeClimaxDetector,
  wpVolumeClimaxSpec,
} from "../src/ta/desk/cells/wpVolumeClimax.js";
import { readLiqTape } from "../src/ta/desk/liqTape.js";

// Phase 4: register all battery detectors (look-ahead self-tests run at import).
registerDetector(wpVolumeClimaxDetector);
registerDetector(wpMaRejectionDetector);

import { collectAll, offlineCollected } from "../src/ta/desk/collectors.js";
import {
  assemblePayload,
  ContractError,
  degradedPayload,
} from "../src/ta/desk/contract.js";
import {
  QUMO_LEDGER,
  readLedgerSummary,
  runBacktest,
} from "../src/ta/desk/deskLedger.js";
import { postPayload } from "../src/ta/desk/post.js";
import type { Collected, QumoTrade } from "../src/ta/desk/types.js";
import { parseLedger } from "../src/ta/ledger.js";
import type { Candle } from "../src/ta/types.js";

const TRADE_FILE = path.join(homedir(), ".patchwork", "qumo-trade.json");

/** Read the watched hypothetical trade, or null when absent/invalid. */
function readTrade(): QumoTrade | null {
  try {
    if (!existsSync(TRADE_FILE)) return null;
    const j = JSON.parse(
      readFileSync(TRADE_FILE, "utf-8"),
    ) as Partial<QumoTrade>;
    if (
      typeof j.symbol === "string" &&
      (j.side === "long" || j.side === "short") &&
      typeof j.entry === "number" &&
      typeof j.stop === "number" &&
      typeof j.target === "number" &&
      typeof j.leverage === "number"
    ) {
      return j as QumoTrade;
    }
  } catch {
    // invalid trade file → idle Rekt Shield
  }
  return null;
}

/** Tri-count from the live ledger: open claims / matured-but-ungraded / graded. */
function triCount(nowMs: number): {
  nRisk: number;
  nWatch: number;
  nConfirm: number;
} {
  if (!existsSync(QUMO_LEDGER)) return { nRisk: 0, nWatch: 0, nConfirm: 0 };
  try {
    const rows = parseLedger(readFileSync(QUMO_LEDGER, "utf-8"));
    let open = 0;
    let matured = 0;
    for (const r of rows) {
      const end = Date.parse(r.outcomeWindowEndsAt);
      if (Number.isFinite(end)) {
        if (nowMs < end) open++;
        else matured++;
      }
    }
    // risk = open forward claims (window not yet closed); watch = matured but
    // not yet graded; confirm = graded (not computed here — always 0 from ledger
    // alone). Conservative tally, never fabricated. (H8: open was wrongly
    // assigned to nWatch instead of nRisk, making two postures unreachable.)
    return { nRisk: open, nWatch: matured, nConfirm: 0 };
  } catch {
    return { nRisk: 0, nWatch: 0, nConfirm: 0 };
  }
}

/** Build the candle map the backtest needs from the live collectors. */
function candleMap(feeds: Collected): Map<string, Candle[]> {
  const m = new Map<string, Candle[]>();
  if (feeds.btc1d.value && feeds.btc1d.value.length > 0) {
    m.set("BTCUSDT", feeds.btc1d.value);
  }
  return m;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run");
  const backtest = args.has("--backtest");
  const nowMs = Date.now();

  if (backtest) {
    const feeds = await collectAll();
    const summary = runBacktest(candleMap(feeds), nowMs);
    console.log("BACKTEST complete. Summary written.");
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  // --gate: run the full battery through cellBacktest with shared Holm correction.
  if (args.has("--gate")) {
    console.log(
      `Running cellBacktest battery (${FAMILY_N} cells, shared Holm)...`,
    );
    const { runBattery } = await import("../src/ta/desk/cellBacktest.js");
    const specs = [wpVolumeClimaxSpec, wpMaRejectionSpec];
    const verdicts = runBattery(specs, FAMILY_N);
    for (const v of verdicts) {
      appendVerdict(v);
      console.log(`\n--- ${v.cellName} ---`);
      console.log(JSON.stringify(v, null, 2));
      console.log(`GATE STATE: ${v.gateState}`);
      if (v.failReason) console.log(`FAIL REASON: ${v.failReason}`);
    }
    return;
  }

  // Compute path (dry-run + default).
  let feeds: Collected;
  try {
    feeds = await collectAll();
  } catch {
    feeds = offlineCollected();
  }

  const allOffline =
    feeds.btc1d.state !== "live" &&
    feeds.btc24hPct.state !== "live" &&
    feeds.funding.state !== "live" &&
    feeds.atlas.state !== "live";

  // Phase 0(b): accrual emitter — startup check + emit today's cards.
  startupCheck();
  emitTodayCards(candleMap(feeds), nowMs);

  const trade = readTrade();
  const tri = triCount(nowMs);
  const ledger = readLedgerSummary();
  const verdicts = readLatestVerdicts();
  const liqTape = readLiqTape(nowMs);
  const cachedLedger = !existsSync(
    path.join(homedir(), ".patchwork", "qumo-ledger-summary.json"),
  );

  let payload: import("../src/ta/desk/types.js").QumoPayload;
  if (allOffline) {
    payload = degradedPayload(nowMs);
  } else {
    try {
      payload = assemblePayload({
        feeds,
        trade,
        ledger,
        tri,
        nowMs,
        cachedLedger,
        verdicts,
        liqTape,
      });
    } catch (err) {
      if (err instanceof ContractError) {
        console.error(`CONTRACT ABORT: ${err.message}`);
        // honest failure → fully-degraded payload still goes out
        payload = degradedPayload(nowMs);
      } else {
        throw err;
      }
    }
  }

  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf-8");

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    console.log(`\n--- payload bytes: ${bytes} (budget 7000) ---`);
    console.log(
      `--- numbersIndex tokens: ${payload.numbersIndex.split("\n").filter(Boolean).length} ---`,
    );
    console.log(`--- feedHealth: ${payload.feedHealthMd} ---`);
    return;
  }

  const res = await postPayload(payload);
  console.log(
    `POST ${res.ok ? "ok" : "failed"} — ${JSON.stringify(res)} (${bytes} bytes)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
