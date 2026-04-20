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
  handleCalendarConnect,
  handleCalendarDisconnect,
  handleCalendarTest,
  listEvents,
  loadTokens,
} from "../googleCalendar.js";

function makeTokenJson(overrides: Record<string, string> = {}) {
  return JSON.stringify({
    api_key: "AIzaTest",
    calendar_id: "primary",
    connected_at: "2026-04-20T00:00:00Z",
    ...overrides,
  });
}

function mockConnected() {
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.readFileSync).mockReturnValue(makeTokenJson());
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
  delete process.env.GOOGLE_CALENDAR_API_KEY;
  delete process.env.GOOGLE_CALENDAR_ID;
});

afterEach(() => {
  vi.restoreAllMocks();
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

  it("uses env vars when set", () => {
    process.env.GOOGLE_CALENDAR_API_KEY = "envKey";
    process.env.GOOGLE_CALENDAR_ID = "env@gmail.com";
    expect(getStatus().status).toBe("connected");
  });
});

// ── loadTokens ───────────────────────────────────────────────────────────────

describe("loadTokens", () => {
  it("returns null when no file and no env", () => {
    expect(loadTokens()).toBeNull();
  });

  it("reads from file when present", () => {
    mockConnected();
    const tok = loadTokens();
    expect(tok?.api_key).toBe("AIzaTest");
    expect(tok?.calendar_id).toBe("primary");
  });

  it("prefers env vars over file", () => {
    mockConnected();
    process.env.GOOGLE_CALENDAR_API_KEY = "envKey";
    process.env.GOOGLE_CALENDAR_ID = "env@cal.com";
    const tok = loadTokens();
    expect(tok?.api_key).toBe("envKey");
    expect(tok?.calendar_id).toBe("env@cal.com");
  });
});

// ── handleCalendarConnect ────────────────────────────────────────────────────

describe("handleCalendarConnect", () => {
  it("returns 400 when api_key missing", async () => {
    const r = await handleCalendarConnect({});
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).ok).toBe(false);
  });

  it("saves tokens on success", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ summary: "My Calendar" }),
      text: async () => "{}",
    } as unknown as Response);

    const r = await handleCalendarConnect({
      api_key: "AIzaTest",
      calendar_id: "primary",
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(true);
    expect(body.summary).toBe("My Calendar");
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalled();
  });

  it("returns 400 when API returns error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => "forbidden",
    } as unknown as Response);

    const r = await handleCalendarConnect({
      api_key: "bad",
      calendar_id: "primary",
    });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).ok).toBe(false);
  });

  it("defaults calendar_id to primary when empty", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ summary: "Cal" }),
      text: async () => "{}",
    } as unknown as Response);

    const r = await handleCalendarConnect({ api_key: "AIza" });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).calendarId).toBe("primary");
  });
});

// ── handleCalendarTest ───────────────────────────────────────────────────────

describe("handleCalendarTest", () => {
  it("returns 400 when not connected", async () => {
    const r = await handleCalendarTest();
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).ok).toBe(false);
  });

  it("returns ok when credentials valid", async () => {
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
  it("deletes token file when it exists", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const r = handleCalendarDisconnect();
    expect(r.status).toBe(200);
    expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalled();
  });

  it("returns ok even when no file", () => {
    const r = handleCalendarDisconnect();
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
