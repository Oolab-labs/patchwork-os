/**
 * Regression: connector write tools (Slack, Notion, HubSpot, Datadog,
 * Confluence, Zendesk, Intercom) checked the kill switch once at the top of
 * execute(), then did an async import()/token-load before their actual
 * network write, with no re-check in between. An operator engaging the
 * kill switch specifically because a run is misbehaving would not stop a
 * write that had already passed its initial check — the "fail-closed
 * emergency brake" framing didn't hold for genuinely in-flight operations.
 *
 * Fixed by adding a second assertWriteAllowed() call immediately before
 * each connector's network call. This test simulates the kill switch
 * flipping ON during the async gap (import + token load) and asserts the
 * write never reaches the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegistry, executeTool } from "../../toolRegistry.js";
import type { RunContext, StepDeps } from "../../yamlRunner.js";

const KILL_SWITCH_ENV = "PATCHWORK_FLAG_KILL_SWITCH_WRITES";

vi.mock("../../../connectors/slack.js", () => ({
  loadTokens: vi.fn(() => {
    // Simulate the kill switch being engaged during the async gap between
    // the first assertWriteAllowed() check and the network call — e.g. an
    // operator hits the emergency stop right as this run's import()/
    // token-load was in flight.
    process.env[KILL_SWITCH_ENV] = "1";
    return {
      access_token: "xoxb-test",
      team_id: "T1",
      team_name: "Acme",
      bot_user_id: "U1",
      connected_at: "2026-01-01T00:00:00Z",
    };
  }),
  postMessage: vi.fn().mockResolvedValue({ ts: "1.0", channel: "C1" }),
}));

const dummyContext = {
  params: { channel: "general", text: "hi" },
  step: {},
  ctx: { env: {}, steps: {} } as unknown as RunContext,
  deps: {} as StepDeps,
};

describe("recipe tool slack.post_message — kill-switch re-check before network write", () => {
  beforeEach(async () => {
    clearRegistry();
    delete process.env[KILL_SWITCH_ENV];
    await import("../slack.js"); // registers "slack.post_message" as a side effect
  });

  afterEach(() => {
    delete process.env[KILL_SWITCH_ENV];
    clearRegistry();
    vi.clearAllMocks();
  });

  it("blocks the write and never calls postMessage when the kill switch engages between the first check and the network call", async () => {
    const { postMessage } = await import("../../../connectors/slack.js");

    await expect(
      executeTool("slack.post_message", dummyContext),
    ).rejects.toThrow(/Write operation blocked by kill switch/);

    expect(postMessage).not.toHaveBeenCalled();
  });
});
