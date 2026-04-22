import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ConnectorRequest {
  name: string;
  notes?: string;
  requestedAt: string;
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

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

  try {
    const dir = path.join(os.homedir(), ".patchwork");
    const file = path.join(dir, "connector-requests.json");

    fs.mkdirSync(dir, { recursive: true });

    let existing: ConnectorRequest[] = [];
    if (fs.existsSync(file)) {
      try {
        const raw = fs.readFileSync(file, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          existing = parsed as ConnectorRequest[];
        }
      } catch {
        // malformed — start fresh
      }
    }

    existing.push(entry);
    fs.writeFileSync(file, JSON.stringify(existing, null, 2), "utf8");
  } catch (e) {
    console.error("[connector-requests] write error", e);
    return NextResponse.json(
      { ok: false, error: "Failed to save request" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
