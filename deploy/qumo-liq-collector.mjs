/**
 * qumo-liq-collector.mjs — resident Binance forced-liquidation tape collector.
 * Plain ES module (no TypeScript). Deploy to VPS; run via systemd.
 *
 * npm install ws   (if ws not already present in the working directory)
 * node qumo-liq-collector.mjs
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const DRY = process.argv.includes("--dry");
const WS_URL = "wss://fstream.binance.com/ws/!forceOrder@arr";
const LIQ_DIR = process.env.QUMO_LIQ_DIR ?? path.join(homedir(), ".patchwork");
const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const PING_INTERVAL_MS = 30_000;

function tapePath(dateStr) {
  mkdirSync(LIQ_DIR, { recursive: true });
  return path.join(LIQ_DIR, `qumo-liq-tape-${dateStr}.jsonl`);
}

function utcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function writeRow(row) {
  if (DRY) {
    process.stdout.write(`${JSON.stringify(row)}\n`);
    return;
  }
  appendFileSync(tapePath(utcDate(row.ts)), `${JSON.stringify(row)}\n`, {
    encoding: "utf-8",
  });
}

function parseForceOrder(ev) {
  if (!ev || ev.e !== "forceOrder" || !ev.o) return null;
  const { s, S, q, p, T } = ev.o;
  const qty = parseFloat(q);
  const price = parseFloat(p);
  if (!Number.isFinite(qty) || !Number.isFinite(price) || price <= 0)
    return null;
  return {
    ts: T,
    sym: s,
    side: S === "SELL" ? "long" : "short",
    qty,
    price,
    usd: Math.round(qty * price),
  };
}

let reconnectDelay = RECONNECT_DELAY_MS;

function connect() {
  const ws = new WebSocket(WS_URL);
  let pingTimer = null;

  ws.on("open", () => {
    process.stderr.write(
      `[liq-collector] connected ${new Date().toISOString()}\n`,
    );
    reconnectDelay = RECONNECT_DELAY_MS;
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, PING_INTERVAL_MS);
  });

  ws.on("message", (raw) => {
    let parsed;
    try {
      parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
      return;
    }
    const events = Array.isArray(parsed) ? parsed : [parsed];
    for (const ev of events) {
      const row = parseForceOrder(ev);
      if (row) writeRow(row);
    }
  });

  ws.on("error", (err) => {
    process.stderr.write(`[liq-collector] error: ${err.message}\n`);
  });

  ws.on("close", () => {
    if (pingTimer) clearInterval(pingTimer);
    process.stderr.write(
      `[liq-collector] disconnected — retry in ${reconnectDelay}ms\n`,
    );
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      connect();
    }, reconnectDelay);
  });
}

process.stderr.write(
  `[liq-collector] starting (LIQ_DIR=${LIQ_DIR} DRY=${DRY})\n`,
);
connect();
