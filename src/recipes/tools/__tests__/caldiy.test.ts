/**
 * Cal.diy recipe-step tool tests.
 *
 * Mocks the caldiy connector module so each tool's `execute` can be driven
 * without network access, then fetches each registered tool from the recipe
 * tool registry by id and asserts:
 *   - the correct connector method is called with faithfully-mirrored args,
 *   - the JSON-stringified connector result is returned verbatim,
 *   - read/write + risk metadata is what the registry advertises.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// ── Connector mock ────────────────────────────────────────────────────────────
// The tool module `await import("../../connectors/caldiy.js")` lazily, so the
// mock must be hoisted (vi.mock is hoisted automatically) and expose
// getCalDiyConnector returning an object of spies. Path is THREE levels up from
// this test file (src/recipes/tools/__tests__) to reach src/connectors.

const getEventTypes = vi.fn();
const getBookings = vi.fn();
const getBooking = vi.fn();
const cancelBooking = vi.fn();

vi.mock("../../../connectors/caldiy.js", () => ({
  getCalDiyConnector: () => ({
    getEventTypes,
    getBookings,
    getBooking,
    cancelBooking,
  }),
}));

// Import AFTER the mock is declared so the self-registering module picks it up.
import "../caldiy.js";
import { getTool } from "../../toolRegistry.js";
import type { RunContext, StepDeps } from "../../yamlRunner.js";

/** Minimal ToolContext factory — tools only read `params`. */
function ctx(params: Record<string, unknown>) {
  return {
    params,
    step: {} as Record<string, unknown>,
    ctx: {} as RunContext,
    deps: {} as StepDeps,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("caldiy recipe-step tools", () => {
  describe("caldiy.list_event_types", () => {
    it("is registered read-only / low risk connector tool", () => {
      const tool = getTool("caldiy.list_event_types");
      expect(tool).toBeDefined();
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls getEventTypes() with no args and returns its JSON", async () => {
      const eventTypes = [
        {
          id: 1,
          slug: "intro",
          title: "Intro Call",
          length: 30,
          hidden: false,
        },
      ];
      getEventTypes.mockResolvedValue(eventTypes);

      const tool = getTool("caldiy.list_event_types");
      const out = await tool?.execute(ctx({}));

      expect(getEventTypes).toHaveBeenCalledWith();
      expect(out).toBe(JSON.stringify(eventTypes));
    });
  });

  describe("caldiy.list_bookings", () => {
    it("is registered read-only / low risk", () => {
      const tool = getTool("caldiy.list_bookings");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls getBookings(opts) with mirrored filters and returns its JSON", async () => {
      const bookings = [
        {
          uid: "bk_1",
          title: "Intro Call",
          start: "2026-06-10T10:00:00Z",
          end: "2026-06-10T10:30:00Z",
          status: "accepted",
          attendees: [],
        },
      ];
      getBookings.mockResolvedValue(bookings);

      const tool = getTool("caldiy.list_bookings");
      const out = await tool?.execute(
        ctx({
          status: "upcoming",
          attendeeEmail: "guest@example.com",
          dateFrom: "2026-06-01",
          dateTo: "2026-06-30",
        }),
      );

      expect(getBookings).toHaveBeenCalledWith({
        status: "upcoming",
        attendeeEmail: "guest@example.com",
        dateFrom: "2026-06-01",
        dateTo: "2026-06-30",
      });
      expect(out).toBe(JSON.stringify(bookings));
    });

    it("passes undefined for omitted optional filters", async () => {
      getBookings.mockResolvedValue([]);
      const tool = getTool("caldiy.list_bookings");
      await tool?.execute(ctx({}));

      expect(getBookings).toHaveBeenCalledWith({
        status: undefined,
        attendeeEmail: undefined,
        dateFrom: undefined,
        dateTo: undefined,
      });
    });
  });

  describe("caldiy.get_booking", () => {
    it("is registered read-only / low risk", () => {
      const tool = getTool("caldiy.get_booking");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
    });

    it("calls getBooking(uid) and returns its JSON", async () => {
      const booking = {
        uid: "bk_1",
        title: "Intro Call",
        start: "2026-06-10T10:00:00Z",
        end: "2026-06-10T10:30:00Z",
        status: "accepted",
        attendees: [
          { name: "Guest", email: "guest@example.com", timeZone: "UTC" },
        ],
      };
      getBooking.mockResolvedValue(booking);

      const tool = getTool("caldiy.get_booking");
      const out = await tool?.execute(ctx({ uid: "bk_1" }));

      expect(getBooking).toHaveBeenCalledWith("bk_1");
      expect(out).toBe(JSON.stringify(booking));
    });
  });

  describe("caldiy.cancel_booking", () => {
    it("is registered as a write / medium risk tool", () => {
      const tool = getTool("caldiy.cancel_booking");
      expect(tool).toBeDefined();
      expect(tool?.isWrite).toBe(true);
      expect(tool?.riskDefault).toBe("medium");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls cancelBooking(uid, reason) and returns its JSON", async () => {
      const cancelled = { uid: "bk_1" };
      cancelBooking.mockResolvedValue(cancelled);

      const tool = getTool("caldiy.cancel_booking");
      const out = await tool?.execute(
        ctx({ uid: "bk_1", reason: "double-booked" }),
      );

      expect(cancelBooking).toHaveBeenCalledWith("bk_1", "double-booked");
      expect(out).toBe(JSON.stringify(cancelled));
    });

    it("passes undefined when reason is omitted", async () => {
      cancelBooking.mockResolvedValue({ uid: "bk_2" });
      const tool = getTool("caldiy.cancel_booking");
      await tool?.execute(ctx({ uid: "bk_2" }));

      expect(cancelBooking).toHaveBeenCalledWith("bk_2", undefined);
    });
  });
});
