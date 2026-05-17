import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { requireSameOrigin } from "@/lib/csrf";
import {
  DASHBOARD_API_BODY_CAPS,
  bodyTooLargeResponse,
  readJsonWithCap,
} from "@/lib/readBodyWithCap";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ConnectorRequest {
  name: string;
  notes?: string;
  requestedAt: string;
}

/**
 * Per-process serialization chain for read-modify-write on
 * connector-requests.json. Audit 2026-05-17: PR #570 made the write
 * atomic, but two concurrent POSTs would still each readFileSync the
 * same array, each push their entry, each renameSync — last writer
 * wins, the other request silently lost. Promise-chain serializes
 * POST handlers within a single Node process; multi-process serverless
 * deployments would need a real flock (out of scope for this PR; the
 * dashboard runs as a single Next.js process in normal deployments).
 */
let writeChain: Promise<void> = Promise.resolve();

/**
 * Returns the list of connector requests the user has submitted via
 * this endpoint. Plumbing audit flagged the route as write-only —
 * users filled out the request form and the result vanished into
 * ~/.patchwork/connector-requests.json. The GET handler closes that
 * loop so the dashboard can surface "Your requests" inline on the
 * connections page.
 */
export async function GET(): Promise<Response> {
  try {
    const file = path.join(os.homedir(), ".patchwork", "connector-requests.json");
    if (!fs.existsSync(file)) {
      return NextResponse.json({ requests: [] });
    }
    const raw = fs.readFileSync(file, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Same defensive handling as POST — surface a clear 500 rather
      // than silently returning an empty list when the file is
      // malformed (which would mask a real disk problem).
      return NextResponse.json(
        { error: "connector-requests.json is malformed — fix or delete it and retry" },
        { status: 500 },
      );
    }
    if (!Array.isArray(parsed)) {
      return NextResponse.json(
        { error: "connector-requests.json has unexpected format — expected an array" },
        { status: 500 },
      );
    }
    // Newest first; cap at a sensible window so the dashboard panel
    // doesn't render hundreds of historical requests.
    const requests = (parsed as ConnectorRequest[])
      .slice()
      .sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1))
      .slice(0, 50);
    return NextResponse.json({ requests });
  } catch (e) {
    console.error("[connector-requests] read error", e);
    return NextResponse.json(
      { error: "Failed to read connector requests" },
      { status: 500 },
    );
  }
}

export async function POST(req: Request): Promise<Response> {
  const guard = requireSameOrigin(req);
  if (guard) return guard;
  const parsed = await readJsonWithCap<unknown>(
    req,
    DASHBOARD_API_BODY_CAPS.connectorRequest,
  );
  if (!parsed.ok) {
    if (parsed.reason === "too_large") return bodyTooLargeResponse(parsed.maxBytes);
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const body = parsed.value;

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  const { name, notes } = body as Record<string, unknown>;

  if (typeof name !== "string" || name.trim().length === 0) {
    return NextResponse.json({ ok: false, error: "name is required" }, { status: 400 });
  }
  if (name.trim().length > 100) {
    return NextResponse.json({ ok: false, error: "name must be 100 chars or fewer" }, { status: 400 });
  }
  if (notes !== undefined && notes !== null) {
    if (typeof notes !== "string") {
      return NextResponse.json({ ok: false, error: "notes must be a string" }, { status: 400 });
    }
    if (notes.length > 500) {
      return NextResponse.json({ ok: false, error: "notes must be 500 chars or fewer" }, { status: 400 });
    }
  }

  const entry: ConnectorRequest = {
    name: name.trim(),
    ...(typeof notes === "string" && notes.trim().length > 0 ? { notes: notes.trim() } : {}),
    requestedAt: new Date().toISOString(),
  };

  // Serialize the read-modify-write through the per-process chain.
  // Result is either a 500 NextResponse from an inner step (carried
  // through as a thrown sentinel) or void for success.
  type InnerError = { status: number; message: string };
  const result = await new Promise<InnerError | null>((resolve) => {
    writeChain = writeChain
      .then(() => {
        try {
          const dir = path.join(os.homedir(), ".patchwork");
          const file = path.join(dir, "connector-requests.json");

          fs.mkdirSync(dir, { recursive: true });

          let existing: ConnectorRequest[] = [];
          if (fs.existsSync(file)) {
            const raw = fs.readFileSync(file, "utf8");
            let parsed: unknown;
            try {
              parsed = JSON.parse(raw);
            } catch {
              resolve({
                status: 500,
                message:
                  "connector-requests.json is malformed — fix or delete it and retry",
              });
              return;
            }
            if (!Array.isArray(parsed)) {
              resolve({
                status: 500,
                message:
                  "connector-requests.json has unexpected format — expected an array",
              });
              return;
            }
            existing = parsed as ConnectorRequest[];
          }

          existing.push(entry);
          // Atomic write: temp file + rename. A crash / ENOSPC during direct
          // writeFileSync would truncate connector-requests.json and wipe every
          // prior request. The surrounding writeChain serializes
          // read-modify-write so two concurrent POSTs can't both read the same
          // array and lose one push to last-writer-wins.
          const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
          fs.writeFileSync(tmp, JSON.stringify(existing, null, 2), "utf8");
          fs.renameSync(tmp, file);
          resolve(null);
        } catch (e) {
          console.error("[connector-requests] write error", e);
          resolve({ status: 500, message: "Failed to save request" });
        }
      })
      .catch(() => {
        // Defensive: shouldn't reach since inner try/catch resolves.
        resolve({ status: 500, message: "Failed to save request" });
      });
  });

  if (result) {
    return NextResponse.json(
      { ok: false, error: result.message },
      { status: result.status },
    );
  }

  return NextResponse.json({ ok: true });
}
