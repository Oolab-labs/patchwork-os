/**
 * Regression: discardAllExpired() (the "Discard expired (N)" bulk action)
 * reset confirmingExpired to false BEFORE the serial rollback loop
 * finished, with no separate in-flight lock. Since expiredIds only
 * refreshes on the next poll tick or a rollback's own refetch(), the
 * "Discard expired (N)" button re-armed immediately while the first batch
 * was still running — a second click (racing the network, or just an
 * impatient double-click) fired a second full pass of rollback POSTs
 * against the same still-listed ids, concurrently with the first.
 *
 * Every per-row Discard button already has this exact guard via the
 * `busy` state; the bulk action had none.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import TransactionsPage from "../page";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const EXPIRED_TX = (id: string) => ({
  id,
  createdAt: Date.now() - 60_000,
  expiresAt: Date.now() - 1_000, // already expired
  edits: [{ filePath: `/tmp/${id}.txt`, sizeBefore: 10, sizeAfter: 20, lineDelta: 1 }],
});

let fetchMock: ReturnType<typeof vi.fn>;
let rollbackCalls: string[];

beforeEach(() => {
  rollbackCalls = [];
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (method === "GET" && url.includes("/api/bridge/transactions") && !url.includes("rollback")) {
      return jsonResponse({ transactions: [EXPIRED_TX("tx-a"), EXPIRED_TX("tx-b")] });
    }
    const rollbackMatch = /\/transactions\/([^/]+)\/rollback$/.exec(url);
    if (method === "POST" && rollbackMatch) {
      const id = rollbackMatch[1]!;
      rollbackCalls.push(id);
      // The bulk loop is serial (await rollback(id) per iteration) — hang
      // the FIRST id's request forever so the loop is deterministically
      // stuck mid-pass, instead of racing real promise timing. If a
      // second bulk pass incorrectly starts, it would show up as a
      // duplicate "tx-a" entry or (if the guard is fully absent) reach
      // "tx-b" out of order.
      if (id === "tx-a") return new Promise<Response>(() => {});
      return jsonResponse({ ok: true });
    }
    return jsonResponse({}, 404);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("discardAllExpired — bulk-discard concurrency guard", () => {
  it("does not fire a second pass of rollback calls while the first is still in flight", async () => {
    render(<TransactionsPage />);

    const armBtn = await screen.findByText(/Discard expired \(2\)/i);
    fireEvent.click(armBtn);

    const confirmBtn = await screen.findByText("Confirm");
    fireEvent.click(confirmBtn);

    // First pass starts with tx-a, which hangs — the serial loop is now
    // stuck mid-pass, exactly the window the pre-fix code left unguarded.
    await waitFor(() => {
      expect(rollbackCalls).toEqual(["tx-a"]);
    });

    // The bulk button must now show the in-flight state, not silently
    // re-arm as a fresh "Discard expired (2)" button a second click could
    // hit. Its title attribute (unlike its "Discarding…" label, which a
    // per-row Discard button can share) uniquely identifies it.
    const discardingBtn = await waitFor(() => {
      const btn = screen.getByTitle(/Discard 2 expired transactions/i);
      expect(btn).toBeDisabled();
      return btn;
    });

    // Simulate the exact race this bug allowed: click again while the
    // first pass is still stuck on tx-a.
    fireEvent.click(discardingBtn);

    // Give any (incorrect) second pass a tick to fire before asserting.
    await new Promise((r) => setTimeout(r, 20));
    expect(rollbackCalls).toEqual(["tx-a"]);
  });
});
