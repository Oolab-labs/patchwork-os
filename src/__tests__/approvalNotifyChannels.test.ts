/**
 * `approvalNotifyChannels` — which server settings are notification channels.
 *
 * The worker gate and the Streamable HTTP gate hand this function the
 * bridge's live settings and pass the result to `enqueueApprovalWithDispatch`.
 * Every field it returns is optional on the receiving side, so a setting it
 * forgets type-checks, queues correctly and silently removes a channel.
 *
 * The two behavioural tests (`workerGateApprovalNotifies`,
 * `streamableHttpApprovalNotifies`) prove the object reaches each gate and
 * cover six of the seven settings by observing the sends. The seventh,
 * `pushServiceAllowPrivate`, changes WHERE a push may be sent rather than
 * whether one is, so nothing there notices if it is dropped — found by
 * mutation. It is pinned here, with the rest, as plain data.
 */

import { describe, expect, it } from "vitest";
import {
  type ApprovalChannelSettings,
  approvalNotifyChannels,
} from "../approvalHttp.js";

/** Every channel setting the bridge's `Server` holds, all set. Synthetic. */
const ALL: Required<ApprovalChannelSettings> = {
  approvalWebhookUrl: "https://hooks.example.test/approvals",
  pushServiceUrl: "https://push.example.test",
  pushServiceToken: "synthetic-relay-token",
  pushServiceBaseUrl: "https://bridge.example.test",
  pushServiceAllowPrivate: true,
  ntfyTopic: "synthetic-topic",
  ntfyServer: "https://ntfy.example.test",
};

describe("approvalNotifyChannels", () => {
  it("carries every channel setting across, under the name the dispatcher reads", () => {
    // Exact: a setting added to one side and not the other fails here.
    expect(approvalNotifyChannels(ALL)).toEqual({
      webhookUrl: ALL.approvalWebhookUrl,
      pushServiceUrl: ALL.pushServiceUrl,
      pushServiceToken: ALL.pushServiceToken,
      pushServiceBaseUrl: ALL.pushServiceBaseUrl,
      pushServiceAllowPrivate: true,
      ntfyTopic: ALL.ntfyTopic,
      ntfyServer: ALL.ntfyServer,
    });
  });

  it("covers every field of the settings type", () => {
    // `Required<>` above makes the compiler demand a value for each declared
    // setting; this makes the test demand that each one comes out the other
    // side. A new setting cannot be declared and quietly not forwarded.
    expect(Object.keys(approvalNotifyChannels(ALL))).toHaveLength(
      Object.keys(ALL).length,
    );
  });

  it("returns no channels when there are no settings", () => {
    // A caller with nowhere to announce: an answer, not an error.
    expect(approvalNotifyChannels(undefined)).toEqual({});
    expect(approvalNotifyChannels(null)).toEqual({});
    expect(approvalNotifyChannels({})).toEqual({});
  });

  it("leaves an unset channel out rather than passing it empty", () => {
    // The server holds `undefined` for an unconfigured channel, and `""` is
    // how the settings route clears one. Neither is a channel.
    expect(
      approvalNotifyChannels({
        approvalWebhookUrl: undefined,
        pushServiceUrl: "",
        ntfyTopic: "synthetic-topic",
      }),
    ).toEqual({ ntfyTopic: "synthetic-topic" });
  });

  it("passes pushServiceAllowPrivate: false through as false", () => {
    // The server's default. `false` is a statement, not an absence.
    expect(approvalNotifyChannels({ pushServiceAllowPrivate: false })).toEqual({
      pushServiceAllowPrivate: false,
    });
  });

  it("reads the settings at the moment it is called", () => {
    // The settings object is live — `POST /settings` rewrites it on a running
    // bridge — so callers hold the object and call this per approval.
    const live: ApprovalChannelSettings = { ntfyTopic: "before" };
    expect(approvalNotifyChannels(live).ntfyTopic).toBe("before");
    live.ntfyTopic = "after";
    live.approvalWebhookUrl = ALL.approvalWebhookUrl;
    expect(approvalNotifyChannels(live)).toEqual({
      ntfyTopic: "after",
      webhookUrl: ALL.approvalWebhookUrl,
    });
  });
});
