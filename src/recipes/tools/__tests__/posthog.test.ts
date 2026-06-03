/**
 * PostHog recipe-step tools — registration + execute dispatch tests.
 *
 * Mocks the posthog connector module so `getPostHogConnector()` returns a fake
 * exposing `captureEvent`/`getInsights`/`queryInsight`/`getEvents` spies.
 * Importing `../posthog.js` self-registers the four tools into the global tool
 * registry; each is then resolved by id and exercised via `executeTool`.
 */

import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeTool, getTool } from "../../toolRegistry.js";
import type { RunContext } from "../../yamlRunner.js";

// Connector method spies — referenced from inside the vi.mock factory and the
// assertions below.
const captureEvent = vi.fn();
const getInsights = vi.fn();
const queryInsight = vi.fn();
const getEvents = vi.fn();

vi.mock("../../../connectors/posthog.js", () => ({
  getPostHogConnector: () => ({
    captureEvent,
    getInsights,
    queryInsight,
    getEvents,
  }),
}));

// Trigger self-registration of the posthog.* tools into the global registry.
import "../posthog.js";

function makeCtx(params: Record<string, unknown>) {
  return {
    params,
    step: { ...params },
    ctx: { env: {}, steps: {} } as unknown as RunContext,
    deps: {
      workdir: tmpdir(),
    } as any,
  };
}

const SAMPLE_INSIGHT = {
  id: 42,
  name: "Weekly active users",
  description: "WAU trend",
  filters: { insight: "TRENDS" },
  result: [{ count: 100 }],
  last_modified_at: "2026-06-01T00:00:00Z",
};

const SAMPLE_EVENT = {
  id: "ev_1",
  distinct_id: "user_1",
  event: "$pageview",
  properties: { $current_url: "https://example.com" },
  timestamp: "2026-06-01T00:00:00Z",
};

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("posthog recipe tools — registration", () => {
  it("registers all four tools under the posthog namespace", () => {
    expect(getTool("posthog.capture_event")).toBeDefined();
    expect(getTool("posthog.list_insights")).toBeDefined();
    expect(getTool("posthog.query_insight")).toBeDefined();
    expect(getTool("posthog.list_events")).toBeDefined();
  });

  it("marks capture_event as a write (isWrite: true, riskDefault medium)", () => {
    const tool = getTool("posthog.capture_event");
    expect(tool?.isWrite).toBe(true);
    expect(tool?.riskDefault).toBe("medium");
    expect(tool?.isConnector).toBe(true);
  });

  it("marks the read tools as reads (isWrite: false, risk low)", () => {
    const list = getTool("posthog.list_insights");
    const query = getTool("posthog.query_insight");
    const events = getTool("posthog.list_events");
    expect(list?.isWrite).toBe(false);
    expect(list?.riskDefault).toBe("low");
    expect(list?.isConnector).toBe(true);
    expect(query?.isWrite).toBe(false);
    expect(query?.riskDefault).toBe("low");
    expect(query?.isConnector).toBe(true);
    expect(events?.isWrite).toBe(false);
    expect(events?.riskDefault).toBe("low");
    expect(events?.isConnector).toBe(true);
  });
});

describe("posthog.capture_event — execute", () => {
  it("calls connector.captureEvent with mapped params and returns JSON", async () => {
    const result = { status: "ok" };
    captureEvent.mockResolvedValue(result);
    const out = await executeTool(
      "posthog.capture_event",
      makeCtx({
        distinctId: "user_1",
        event: "signed_up",
        properties: { plan: "pro" },
        timestamp: "2026-06-01T00:00:00Z",
      }),
    );
    expect(captureEvent).toHaveBeenCalledTimes(1);
    expect(captureEvent).toHaveBeenCalledWith(
      "user_1",
      "signed_up",
      { plan: "pro" },
      "2026-06-01T00:00:00Z",
    );
    expect(out).toBe(JSON.stringify(result));
  });

  it("passes undefined for omitted properties and timestamp", async () => {
    captureEvent.mockResolvedValue({ status: "ok" });
    await executeTool(
      "posthog.capture_event",
      makeCtx({ distinctId: "user_2", event: "logged_in" }),
    );
    expect(captureEvent).toHaveBeenCalledWith(
      "user_2",
      "logged_in",
      undefined,
      undefined,
    );
  });
});

describe("posthog.list_insights — execute", () => {
  it("calls connector.getInsights with projectId and limit and returns JSON", async () => {
    const insights = [SAMPLE_INSIGHT];
    getInsights.mockResolvedValue(insights);
    const out = await executeTool(
      "posthog.list_insights",
      makeCtx({ projectId: 123, limit: 5 }),
    );
    expect(getInsights).toHaveBeenCalledTimes(1);
    expect(getInsights).toHaveBeenCalledWith(123, 5);
    expect(out).toBe(JSON.stringify(insights));
  });

  it("passes undefined limit when omitted", async () => {
    getInsights.mockResolvedValue([]);
    await executeTool(
      "posthog.list_insights",
      makeCtx({ projectId: "proj_abc" }),
    );
    expect(getInsights).toHaveBeenCalledWith("proj_abc", undefined);
  });
});

describe("posthog.query_insight — execute", () => {
  it("calls connector.queryInsight with projectId and query and returns JSON", async () => {
    const queryResult = { results: [[1, 2, 3]], columns: ["count"] };
    queryInsight.mockResolvedValue(queryResult);
    const query = { kind: "HogQLQuery", query: "SELECT count() FROM events" };
    const out = await executeTool(
      "posthog.query_insight",
      makeCtx({ projectId: 123, query }),
    );
    expect(queryInsight).toHaveBeenCalledTimes(1);
    expect(queryInsight).toHaveBeenCalledWith(123, query);
    expect(out).toBe(JSON.stringify(queryResult));
  });
});

describe("posthog.list_events — execute", () => {
  it("calls connector.getEvents with mapped filters and returns JSON", async () => {
    const events = [SAMPLE_EVENT];
    getEvents.mockResolvedValue(events);
    const out = await executeTool(
      "posthog.list_events",
      makeCtx({
        projectId: 123,
        event: "$pageview",
        personId: "p_1",
        after: "2026-05-01",
        before: "2026-06-01",
        limit: 10,
      }),
    );
    expect(getEvents).toHaveBeenCalledTimes(1);
    expect(getEvents).toHaveBeenCalledWith(123, {
      event: "$pageview",
      personId: "p_1",
      after: "2026-05-01",
      before: "2026-06-01",
      limit: 10,
    });
    expect(out).toBe(JSON.stringify(events));
  });

  it("passes undefined for omitted filters", async () => {
    getEvents.mockResolvedValue([]);
    await executeTool("posthog.list_events", makeCtx({ projectId: 123 }));
    expect(getEvents).toHaveBeenCalledWith(123, {
      event: undefined,
      personId: undefined,
      after: undefined,
      before: undefined,
      limit: undefined,
    });
  });
});
