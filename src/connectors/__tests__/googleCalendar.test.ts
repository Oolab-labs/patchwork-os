import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import * as fs from "node:fs";
import {
  getStatus,
  handleCalendarAuthRedirect,
  handleCalendarCallback,
  handleCalendarDisconnect,
  handleCalendarTest,
  listEvents,
  loadTokens,
} from "../googleCalendar.js";

function makeTokenJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    access_token: "at_test",
    refresh_token: "rt_test",
    expiry_date: Date.now() + 60 * 60 * 1000,
    calendar_id: "primary",
    connected_at: "2026-04-20T00:00:00Z",
    ...overrides,
  });
}

function mockConnected(overrides: Record<string, unknown> = {}) {
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.readFileSync).mockReturnValue(makeTokenJson(overrides));
}

function makeEventsResponse(items: unknown[] = []) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ items }),
    text: async () => JSON.stringify({ items }),
  } as unknown as Response;
}

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReturnValue(false);
  mockFetch.mockReset();
  process.env.GOOGLE_CALENDAR_CLIENT_ID = "cid";
  process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "csecret";
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GOOGLE_CALENDAR_CLIENT_ID;
  delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
});

// ── getStatus ────────────────────────────────────────────────────────────────

describe("getStatus", () => {
  it("returns disconnected when no token file", () => {
    expect(getStatus().status).toBe("disconnected");
  });

  it("returns connected when token file exists", () => {
    mockConnected();
    const s = getStatus();
    expect(s.status).toBe("connected");
    expect(s.lastSync).toBe("2026-04-20T00:00:00Z");
    expect(s.calendarId).toBe("primary");
  });
});

// ── loadTokens ───────────────────────────────────────────────────────────────

describe("loadTokens", () => {
  it("returns null when no file", () => {
    expect(loadTokens()).toBeNull();
  });

  it("reads from file when present", () => {
    mockConnected();
    const tok = loadTokens();
    expect(tok?.access_token).toBe("at_test");
    expect(tok?.calendar_id).toBe("primary");
  });
});

// ── handleCalendarAuthRedirect ───────────────────────────────────────────────

describe("handleCalendarAuthRedirect", () => {
  it("returns 400 when client env vars unset", () => {
    delete process.env.GOOGLE_CALENDAR_CLIENT_ID;
    delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
    const r = handleCalendarAuthRedirect();
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).ok).toBe(false);
  });

  it("returns 302 redirect to Google when configured", () => {
    const r = handleCalendarAuthRedirect();
    expect(r.status).toBe(302);
    expect(r.redirect).toMatch(/accounts\.google\.com\/o\/oauth2\/v2\/auth/);
    expect(r.redirect).toMatch(/client_id=cid/);
    expect(r.redirect).toMatch(/state=/);
  });
});

// ── handleCalendarCallback ───────────────────────────────────────────────────

describe("handleCalendarCallback", () => {
  it("returns 400 on oauth error param", async () => {
    const r = await handleCalendarCallback(null, null, "access_denied");
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).error).toBe("access_denied");
  });

  it("returns 400 on missing code", async () => {
    const r = await handleCalendarCallback(null, "somestate", null);
    expect(r.status).toBe(400);
  });

  it("returns 400 on unknown state (CSRF)", async () => {
    const r = await handleCalendarCallback("code123", "unknownstate", null);
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/state/i);
  });

  it("exchanges code + saves tokens on valid state", async () => {
    // Generate a real state via the auth redirect path
    const auth = handleCalendarAuthRedirect();
    const url = new URL(auth.redirect ?? "");
    const state = url.searchParams.get("state");
    expect(state).toBeTruthy();

    // Token exchange response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "at_new",
        refresh_token: "rt_new",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "https://www.googleapis.com/auth/calendar.readonly",
      }),
      text: async () => "{}",
    } as unknown as Response);
    // Calendar summary lookup
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ summary: "My Cal" }),
      text: async () => "{}",
    } as unknown as Response);

    const r = await handleCalendarCallback("code123", state, null);
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(true);
    expect(body.calendarId).toBe("primary");
    expect(body.summary).toBe("My Cal");
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalled();
  });
});

// ── handleCalendarTest ───────────────────────────────────────────────────────

describe("handleCalendarTest", () => {
  it("returns 400 when not connected", async () => {
    const r = await handleCalendarTest();
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).ok).toBe(false);
  });

  it("returns ok when token valid", async () => {
    mockConnected();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ summary: "My Calendar" }),
      text: async () => "{}",
    } as unknown as Response);

    const r = await handleCalendarTest();
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).ok).toBe(true);
  });
});

// ── handleCalendarDisconnect ─────────────────────────────────────────────────

describe("handleCalendarDisconnect", () => {
  it("deletes token file and revokes when it exists", async () => {
    mockConnected();
    // Revoke call
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => "{}",
    } as unknown as Response);
    const r = await handleCalendarDisconnect();
    expect(r.status).toBe(200);
    expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalled();
  });

  it("returns ok even when no file", async () => {
    const r = await handleCalendarDisconnect();
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).ok).toBe(true);
  });
});

// ── listEvents ───────────────────────────────────────────────────────────────

describe("listEvents", () => {
  it("throws when not connected", async () => {
    await expect(listEvents()).rejects.toThrow("not connected");
  });

  it("returns empty array when API returns no items", async () => {
    mockConnected();
    mockFetch.mockResolvedValueOnce(makeEventsResponse([]));
    const events = await listEvents();
    expect(events).toEqual([]);
  });

  it("maps API items to CalendarEvent shape", async () => {
    mockConnected();
    mockFetch.mockResolvedValueOnce(
      makeEventsResponse([
        {
          id: "evt1",
          summary: "Standup",
          start: { dateTime: "2026-04-20T09:00:00Z" },
          end: { dateTime: "2026-04-20T09:30:00Z" },
          htmlLink: "https://calendar.google.com/evt1",
          attendees: [{ displayName: "Alice" }, { email: "bob@example.com" }],
        },
      ]),
    );
    const events = await listEvents();
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe("Standup");
    expect(events[0].allDay).toBe(false);
    expect(events[0].attendees).toEqual(["Alice", "bob@example.com"]);
  });

  it("sets allDay true for date-only events", async () => {
    mockConnected();
    mockFetch.mockResolvedValueOnce(
      makeEventsResponse([
        {
          id: "evt2",
          summary: "Holiday",
          start: { date: "2026-04-21" },
          end: { date: "2026-04-22" },
          htmlLink: "",
        },
      ]),
    );
    const events = await listEvents();
    expect(events[0].allDay).toBe(true);
  });

  it("respects custom calendarId override", async () => {
    mockConnected();
    mockFetch.mockResolvedValueOnce(makeEventsResponse([]));
    await listEvents({ calendarId: "other@gmail.com" });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("other%40gmail.com"),
      expect.anything(),
    );
  });
});
