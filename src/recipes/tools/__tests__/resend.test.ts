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
const cancelEmail = vi.fn();

vi.mock("../../../connectors/resend.js", () => ({
  getResendConnector: () => ({ sendEmail, listEmails, getEmail, cancelEmail }),
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

// ── Compensating action (#1264) ──────────────────────────────────────────────
// Resend can cancel an email only while it is still queued/scheduled — this is
// a pre-delivery hold, NOT a recall. Once handed to the MTA nothing can undo
// it. The connector has implemented cancelEmail all along; no recipe could
// reach it, so a scheduled send had no inverse.
describe("resend.cancel_email", () => {
  it("is registered as a write tool", () => {
    const tool = getTool("resend.cancel_email");
    expect(tool).toBeDefined();
    expect(tool?.isWrite).toBe(true);
    expect(tool?.isConnector).toBe(true);
  });

  it("calls cancelEmail(id) and returns its result", async () => {
    cancelEmail.mockResolvedValue({ object: "email", id: "e_1" });
    const out = await getTool("resend.cancel_email")?.execute(
      makeCtx({ id: "e_1" }, "resend.cancel_email"),
    );
    expect(cancelEmail).toHaveBeenCalledWith("e_1");
    expect(JSON.parse(out as string)).toEqual({ object: "email", id: "e_1" });
  });

  it("send_email surfaces the id a later cancel must target", async () => {
    sendEmail.mockResolvedValue({ id: "e_2" });
    const out = await getTool("resend.send_email")?.execute(
      makeCtx(
        { from: "a@b.c", to: "d@e.f", subject: "s", text: "t" },
        "resend.send_email",
      ),
    );
    expect(JSON.parse(out as string).id).toBe("e_2");
  });
});
