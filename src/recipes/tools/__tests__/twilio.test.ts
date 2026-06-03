/**
 * Twilio recipe-step tools — registration + execute dispatch tests.
 *
 * Mocks the twilio connector module so `getTwilioConnector()` returns a fake
 * exposing `sendSms`/`listMessages`/`getMessage` spies. Importing `../twilio.js`
 * self-registers the three tools into the global tool registry; each is then
 * resolved by id and exercised via `executeTool`.
 */

import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeTool, getTool } from "../../toolRegistry.js";
import type { RunContext } from "../../yamlRunner.js";

// Connector method spies — referenced from inside the vi.mock factory and the
// assertions below.
const sendSms = vi.fn();
const listMessages = vi.fn();
const getMessage = vi.fn();

vi.mock("../../../connectors/twilio.js", () => ({
  getTwilioConnector: () => ({
    sendSms,
    listMessages,
    getMessage,
  }),
}));

// Trigger self-registration of the twilio.* tools into the global registry.
import "../twilio.js";

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

const SAMPLE_MESSAGE = {
  sid: "SM123",
  account_sid: "AC456",
  to: "+14155551234",
  from: "+14155550000",
  body: "hello",
  status: "queued",
  direction: "outbound-api",
  date_sent: null,
  date_created: "2026-06-01T00:00:00Z",
  date_updated: "2026-06-01T00:00:00Z",
  price: null,
  price_unit: null,
  error_code: null,
  error_message: null,
  num_segments: "1",
  num_media: "0",
  uri: "/2010-04-01/Accounts/AC456/Messages/SM123.json",
};

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("twilio recipe tools — registration", () => {
  it("registers all three tools under the twilio namespace", () => {
    expect(getTool("twilio.send_sms")).toBeDefined();
    expect(getTool("twilio.list_messages")).toBeDefined();
    expect(getTool("twilio.get_message")).toBeDefined();
  });

  it("marks send_sms as a write (isWrite: true, riskDefault medium)", () => {
    const tool = getTool("twilio.send_sms");
    expect(tool?.isWrite).toBe(true);
    expect(tool?.riskDefault).toBe("medium");
    expect(tool?.isConnector).toBe(true);
  });

  it("marks list_messages and get_message as reads (isWrite: false, risk low)", () => {
    const list = getTool("twilio.list_messages");
    const get = getTool("twilio.get_message");
    expect(list?.isWrite).toBe(false);
    expect(list?.riskDefault).toBe("low");
    expect(get?.isWrite).toBe(false);
    expect(get?.riskDefault).toBe("low");
  });
});

describe("twilio.send_sms — execute", () => {
  it("calls connector.sendSms with mapped params and returns the JSON-stringified message", async () => {
    sendSms.mockResolvedValue(SAMPLE_MESSAGE);
    const out = await executeTool(
      "twilio.send_sms",
      makeCtx({ to: "+14155551234", body: "hello", from: "+14155550000" }),
    );
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(sendSms).toHaveBeenCalledWith({
      to: "+14155551234",
      body: "hello",
      from: "+14155550000",
    });
    expect(out).toBe(JSON.stringify(SAMPLE_MESSAGE));
  });

  it("omits 'from' when not supplied (passes undefined)", async () => {
    sendSms.mockResolvedValue(SAMPLE_MESSAGE);
    await executeTool(
      "twilio.send_sms",
      makeCtx({ to: "+14155551234", body: "hi" }),
    );
    expect(sendSms).toHaveBeenCalledWith({
      to: "+14155551234",
      body: "hi",
      from: undefined,
    });
  });
});

describe("twilio.list_messages — execute", () => {
  it("calls connector.listMessages with mapped filters and returns JSON", async () => {
    const listResult = {
      messages: [SAMPLE_MESSAGE],
      page: 0,
      page_size: 20,
      next_page_uri: null,
    };
    listMessages.mockResolvedValue(listResult);
    const out = await executeTool(
      "twilio.list_messages",
      makeCtx({
        to: "+14155551234",
        from: "+14155550000",
        dateSent: "2026-06-01",
        limit: 5,
      }),
    );
    expect(listMessages).toHaveBeenCalledTimes(1);
    expect(listMessages).toHaveBeenCalledWith({
      to: "+14155551234",
      from: "+14155550000",
      dateSent: "2026-06-01",
      limit: 5,
    });
    expect(out).toBe(JSON.stringify(listResult));
  });

  it("passes undefined for omitted filters", async () => {
    const listResult = {
      messages: [],
      page: 0,
      page_size: 20,
      next_page_uri: null,
    };
    listMessages.mockResolvedValue(listResult);
    await executeTool("twilio.list_messages", makeCtx({}));
    expect(listMessages).toHaveBeenCalledWith({
      to: undefined,
      from: undefined,
      dateSent: undefined,
      limit: undefined,
    });
  });
});

describe("twilio.get_message — execute", () => {
  it("calls connector.getMessage with the messageSid and returns JSON", async () => {
    getMessage.mockResolvedValue(SAMPLE_MESSAGE);
    const out = await executeTool(
      "twilio.get_message",
      makeCtx({ messageSid: "SM123" }),
    );
    expect(getMessage).toHaveBeenCalledTimes(1);
    expect(getMessage).toHaveBeenCalledWith("SM123");
    expect(out).toBe(JSON.stringify(SAMPLE_MESSAGE));
  });
});
