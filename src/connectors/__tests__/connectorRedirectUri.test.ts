import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  connectorCallbackBase,
  connectorRedirectUri,
} from "../connectorRedirectUri.js";

describe("connectorRedirectUri", () => {
  const saved = {
    dash: process.env.PATCHWORK_DASHBOARD_URL,
    bridge: process.env.PATCHWORK_BRIDGE_URL,
    port: process.env.PATCHWORK_BRIDGE_PORT,
  };

  beforeEach(() => {
    delete process.env.PATCHWORK_DASHBOARD_URL;
    delete process.env.PATCHWORK_BRIDGE_URL;
    delete process.env.PATCHWORK_BRIDGE_PORT;
  });

  afterEach(() => {
    for (const [k, v] of [
      ["PATCHWORK_DASHBOARD_URL", saved.dash],
      ["PATCHWORK_BRIDGE_URL", saved.bridge],
      ["PATCHWORK_BRIDGE_PORT", saved.port],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("derives from PATCHWORK_DASHBOARD_URL when set", () => {
    process.env.PATCHWORK_DASHBOARD_URL = "https://app.example.com/dashboard";
    expect(connectorRedirectUri("slack")).toBe(
      "https://app.example.com/dashboard/connections/slack/callback",
    );
  });

  it("prefers PATCHWORK_DASHBOARD_URL over PATCHWORK_BRIDGE_URL", () => {
    process.env.PATCHWORK_DASHBOARD_URL = "https://dash.example.com";
    process.env.PATCHWORK_BRIDGE_URL = "https://bridge.example.com";
    expect(connectorCallbackBase()).toBe("https://dash.example.com");
  });

  it("falls back to PATCHWORK_BRIDGE_URL when no dashboard URL", () => {
    process.env.PATCHWORK_BRIDGE_URL = "https://bridge.example.com";
    expect(connectorRedirectUri("github")).toBe(
      "https://bridge.example.com/connections/github/callback",
    );
  });

  it("falls back to localhost with the configured bridge port", () => {
    process.env.PATCHWORK_BRIDGE_PORT = "9999";
    expect(connectorRedirectUri("gmail")).toBe(
      "http://localhost:9999/connections/gmail/callback",
    );
  });

  it("defaults to port 3101 when nothing is configured", () => {
    expect(connectorRedirectUri("asana")).toBe(
      "http://localhost:3101/connections/asana/callback",
    );
  });

  it("trims trailing slashes from the base URL", () => {
    process.env.PATCHWORK_DASHBOARD_URL = "https://app.example.com/dashboard//";
    expect(connectorRedirectUri("google-calendar")).toBe(
      "https://app.example.com/dashboard/connections/google-calendar/callback",
    );
  });
});
