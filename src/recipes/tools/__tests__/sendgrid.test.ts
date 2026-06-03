/**
 * SendGrid recipe-step tool tests.
 *
 * Mocks the SendGrid connector singleton so `getSendGridConnector()` returns
 * spy methods, imports the self-registering tool module, then fetches each
 * tool from the registry by id and exercises its `execute`.
 *
 * Covers: send_email (write), list_templates (read), get_stats (read), and
 * the isWrite/riskDefault metadata contract.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const sendSpy = vi.fn();
const listTemplatesSpy = vi.fn();
const getStatsSpy = vi.fn();

vi.mock("../../../connectors/sendgrid.js", () => ({
  getSendGridConnector: () => ({
    send: sendSpy,
    listTemplates: listTemplatesSpy,
    getStats: getStatsSpy,
  }),
}));

// Self-register the sendgrid recipe-step tools into the registry.
import "../sendgrid.js";
import { getTool, type ToolContext } from "../../toolRegistry.js";

/** Build a minimal ToolContext — execute() only reads `params`. */
function ctx(params: Record<string, unknown>): ToolContext {
  return {
    params,
    step: {},
    ctx: {} as ToolContext["ctx"],
    deps: {} as ToolContext["deps"],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── sendgrid.send_email ───────────────────────────────────────────────────────

describe("sendgrid.send_email", () => {
  it("is registered as a write tool with medium risk", () => {
    const tool = getTool("sendgrid.send_email");
    expect(tool).toBeDefined();
    expect(tool?.isWrite).toBe(true);
    expect(tool?.riskDefault).toBe("medium");
    expect(tool?.isConnector).toBe(true);
  });

  it("calls connector.send with mapped params and returns messageId", async () => {
    sendSpy.mockResolvedValue({ messageId: "msg-abc-123" });

    const tool = getTool("sendgrid.send_email");
    const result = await tool?.execute(
      ctx({
        to: "dest@example.com",
        subject: "Hello",
        text: "Plain body",
        html: "<p>HTML body</p>",
        from: "sender@example.com",
      }),
    );

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith({
      to: "dest@example.com",
      subject: "Hello",
      text: "Plain body",
      html: "<p>HTML body</p>",
      from: "sender@example.com",
    });
    expect(JSON.parse(result ?? "{}")).toEqual({
      ok: true,
      messageId: "msg-abc-123",
    });
  });

  it("passes undefined for omitted optional params", async () => {
    sendSpy.mockResolvedValue({ messageId: "msg-xyz" });

    const tool = getTool("sendgrid.send_email");
    await tool?.execute(
      ctx({ to: "dest@example.com", subject: "Hi", text: "yo" }),
    );

    expect(sendSpy).toHaveBeenCalledWith({
      to: "dest@example.com",
      subject: "Hi",
      text: "yo",
      html: undefined,
      from: undefined,
    });
  });

  it("returns ok:false with the error message when send throws", async () => {
    sendSpy.mockRejectedValue(
      new Error("send: `to` must be a valid email address"),
    );

    const tool = getTool("sendgrid.send_email");
    const result = await tool?.execute(
      ctx({ to: "bad", subject: "x", text: "y" }),
    );

    expect(JSON.parse(result ?? "{}")).toEqual({
      ok: false,
      error: "send: `to` must be a valid email address",
    });
  });
});

// ── sendgrid.list_templates ───────────────────────────────────────────────────

describe("sendgrid.list_templates", () => {
  it("is registered as a read tool with low risk", () => {
    const tool = getTool("sendgrid.list_templates");
    expect(tool).toBeDefined();
    expect(tool?.isWrite).toBe(false);
    expect(tool?.riskDefault).toBe("low");
    expect(tool?.isConnector).toBe(true);
  });

  it("calls connector.listTemplates with mapped params and returns the result", async () => {
    const templates = {
      result: [{ id: "t-1", name: "Welcome", generation: "dynamic" as const }],
    };
    listTemplatesSpy.mockResolvedValue(templates);

    const tool = getTool("sendgrid.list_templates");
    const result = await tool?.execute(
      ctx({ limit: 5, generations: "dynamic" }),
    );

    expect(listTemplatesSpy).toHaveBeenCalledTimes(1);
    expect(listTemplatesSpy).toHaveBeenCalledWith({
      limit: 5,
      generations: "dynamic",
    });
    expect(JSON.parse(result ?? "{}")).toEqual(templates);
  });

  it("maps omitted/invalid filters to undefined", async () => {
    listTemplatesSpy.mockResolvedValue({ result: [] });

    const tool = getTool("sendgrid.list_templates");
    await tool?.execute(ctx({ generations: "bogus" }));

    expect(listTemplatesSpy).toHaveBeenCalledWith({
      limit: undefined,
      generations: undefined,
    });
  });
});

// ── sendgrid.get_stats ────────────────────────────────────────────────────────

describe("sendgrid.get_stats", () => {
  it("is registered as a read tool with low risk", () => {
    const tool = getTool("sendgrid.get_stats");
    expect(tool).toBeDefined();
    expect(tool?.isWrite).toBe(false);
    expect(tool?.riskDefault).toBe("low");
    expect(tool?.isConnector).toBe(true);
  });

  it("calls connector.getStats with mapped params and wraps the array in {data}", async () => {
    const buckets = [
      {
        date: "2026-06-01",
        stats: [{ metrics: { delivered: 10, opens: 4 } }],
      },
    ];
    getStatsSpy.mockResolvedValue(buckets);

    const tool = getTool("sendgrid.get_stats");
    const result = await tool?.execute(
      ctx({
        startDate: "2026-06-01",
        endDate: "2026-06-02",
        aggregatedBy: "day",
      }),
    );

    expect(getStatsSpy).toHaveBeenCalledTimes(1);
    expect(getStatsSpy).toHaveBeenCalledWith({
      startDate: "2026-06-01",
      endDate: "2026-06-02",
      aggregatedBy: "day",
    });
    expect(JSON.parse(result ?? "{}")).toEqual({ data: buckets });
  });

  it("maps omitted/invalid optionals to undefined", async () => {
    getStatsSpy.mockResolvedValue([]);

    const tool = getTool("sendgrid.get_stats");
    await tool?.execute(ctx({ startDate: "2026-06-01", aggregatedBy: "year" }));

    expect(getStatsSpy).toHaveBeenCalledWith({
      startDate: "2026-06-01",
      endDate: undefined,
      aggregatedBy: undefined,
    });
  });
});
