/**
 * Connector logos ship inside the dashboard (Private/52 LOW).
 *
 * The connections page fetched every logo from cdn.simpleicons.org,
 * cdn.jsdelivr.net or monday.com on each view — telling three outside parties
 * the viewer's address and which services this workspace connects. The icons
 * now come from the pinned, CC0-licensed `simple-icons` package and render
 * inline; nothing is fetched.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectorLogo } from "./connectorLogos";

const PAGE = join(__dirname, "..", "app", "connections", "page.tsx");

describe("connector logos", () => {
  it("the connections page names no third-party image host", () => {
    const src = readFileSync(PAGE, "utf8");
    for (const host of [
      "cdn.simpleicons.org",
      "cdn.jsdelivr.net",
      "monday.com/static",
    ]) {
      expect(src, host).not.toContain(host);
    }
  });

  it.each([
    "github",
    "slack",
    "salesforce",
    "twilio",
    "sendgrid",
    "google-calendar",
    "google-docs",
    "postgres",
    "caldiy",
    "supabase",
  ])("%s has a bundled icon", (id) => {
    const logo = connectorLogo(id);
    expect(logo?.path.length ?? 0).toBeGreaterThan(20);
    expect(logo?.title.length ?? 0).toBeGreaterThan(0);
  });

  it("a connector with no icon in the package falls back (null)", () => {
    expect(connectorLogo("monday")).toBeNull();
    expect(connectorLogo("paystack")).toBeNull();
  });
});
