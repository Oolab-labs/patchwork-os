/**
 * Resend recipe-tool wrappers — registration + execute mapping tests.
 *
 * Mocks the underlying connector (getResendConnector → spies) so no real
 * network calls happen; asserts each tool maps params → connector method and
 * JSON-stringifies the connector result.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTool } from "../../toolRegistry.js";
import type { RunContext } from "../../yamlRunner.js";

// Spies for the connector methods, shared across tests.
const sendEmail = vi.fn();
const listEmails = vi.fn();
const getEmail = vi.fn();

vi.mock("../../../connectors/resend.js", () => ({
  getResendConnector: () => ({ sendEmail, listEmails, getEmail }),
}));

// Trigger self-registration of the resend.* tools into the global registry.
import "../resend.js";

function makeCtx(params: Record<string, unknown>, toolId: string) {
  return {
    params,
    step: { ...params, tool: toolId },
    ctx: { env: {}, steps: {} } as unknown as RunContext,
    deps: {} as never,
  };
}

beforeEach(() => {
  sendEmail.mockReset();
  listEmails.mockReset();
  getEmail.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("resend recipe tools — registration", () => {
  it("registers resend.send_email as a write tool with medium risk", () => {
    const tool = getTool("resend.send_email");
    expect(tool).toBeDefined();
    expect(tool?.namespace).toBe("resend");
    expect(tool?.isWrite).toBe(true);
    expect(tool?.riskDefault).toBe("medium");
    expect(tool?.isConnector).toBe(true);
  });

  it("registers resend.list_emails as a read tool with low risk", () => {
    const tool = getTool("resend.list_emails");
    expect(tool).toBeDefined();
    expect(tool?.isWrite).toBe(false);
    expect(tool?.riskDefault).toBe("low");
  });

  it("registers resend.get_email as a read tool with low risk", () => {
    const tool = getTool("resend.get_email");
    expect(tool).toBeDefined();
    expect(tool?.isWrite).toBe(false);
    expect(tool?.riskDefault).toBe("low");
  });
});

describe("resend.send_email — execute", () => {
  it("maps params to sendEmail and stringifies the result", async () => {
    sendEmail.mockResolvedValue({ id: "email_123" });
    const tool = getTool("resend.send_email");
    const result = await tool?.execute(
      makeCtx(
        {
          from: "noreply@example.com",
          to: "user@example.com",
          subject: "Hello",
          text: "Hi there",
          reply_to: "support@example.com",
        },
        "resend.send_email",
      ),
    );

    expect(sendEmail).toHaveBeenCalledWith({
      from: "noreply@example.com",
      to: "user@example.com",
      subject: "Hello",
      html: undefined,
      text: "Hi there",
      replyTo: "support@example.com",
    });
    expect(result).toBe(JSON.stringify({ id: "email_123" }));
  });

  it("passes html body and array recipients through", async () => {
    sendEmail.mockResolvedValue({ id: "email_456" });
    const tool = getTool("resend.send_email");
    await tool?.execute(
      makeCtx(
        {
          from: "noreply@example.com",
          to: ["a@example.com", "b@example.com"],
          subject: "Multi",
          html: "<p>Hi</p>",
        },
        "resend.send_email",
      ),
    );

    expect(sendEmail).toHaveBeenCalledWith({
      from: "noreply@example.com",
      to: ["a@example.com", "b@example.com"],
      subject: "Multi",
      html: "<p>Hi</p>",
      text: undefined,
      replyTo: undefined,
    });
  });
});

describe("resend.list_emails — execute", () => {
  it("maps limit/page to listEmails and stringifies the result", async () => {
    const listResult = {
      object: "list",
      data: [{ object: "email", id: "email_1" }],
    };
    listEmails.mockResolvedValue(listResult);
    const tool = getTool("resend.list_emails");
    const result = await tool?.execute(
      makeCtx({ limit: 5, page: 2 }, "resend.list_emails"),
    );

    expect(listEmails).toHaveBeenCalledWith({ limit: 5, page: 2 });
    expect(result).toBe(JSON.stringify(listResult));
  });

  it("omits non-number limit/page (passes undefined)", async () => {
    listEmails.mockResolvedValue({ object: "list", data: [] });
    const tool = getTool("resend.list_emails");
    await tool?.execute(makeCtx({}, "resend.list_emails"));

    expect(listEmails).toHaveBeenCalledWith({
      limit: undefined,
      page: undefined,
    });
  });
});

describe("resend.get_email — execute", () => {
  it("passes id to getEmail and stringifies the result", async () => {
    const email = {
      object: "email",
      id: "email_789",
      to: "user@example.com",
      from: "noreply@example.com",
      subject: "Hi",
      created_at: "2026-06-03T00:00:00Z",
    };
    getEmail.mockResolvedValue(email);
    const tool = getTool("resend.get_email");
    const result = await tool?.execute(
      makeCtx({ id: "email_789" }, "resend.get_email"),
    );

    expect(getEmail).toHaveBeenCalledWith("email_789");
    expect(result).toBe(JSON.stringify(email));
  });
});
