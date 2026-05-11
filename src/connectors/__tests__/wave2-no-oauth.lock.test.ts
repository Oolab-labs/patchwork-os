/**
 * Wave-2 connector contract lock: getOAuthConfig() === null.
 *
 * Every Wave-2 connector ships with API-token or Basic-auth credentials,
 * not OAuth refresh. Their `getOAuthConfig()` returns null, which makes
 * `BaseConnector.refreshToken()` an unreachable no-op for them (see
 * src/connectors/baseConnector.ts:151-155).
 *
 * This file locks that contract. A future commit that accidentally
 * adds a real OAuth config to any of these connectors — without a
 * companion refresh test — will trip these assertions.
 *
 * Real OAuth-refresh tests for the connectors that DO have a token
 * endpoint (Asana, Discord, GitLab, plus the standalone Google
 * modules: gmail, googleCalendar, googleDrive) live in their own
 * `*Refresh.test.ts` files.
 *
 * Background: docs/recipe-authoring-wave2-plan.md:75-79.
 */

import { describe, expect, it } from "vitest";
import { ConfluenceConnector } from "../confluence.js";
import { DatadogConnector } from "../datadog.js";
import { HubSpotConnector } from "../hubspot.js";
import { IntercomConnector } from "../intercom.js";
import { JiraConnector } from "../jira.js";
import { NotionConnector } from "../notion.js";
import { StripeConnector } from "../stripe.js";
import { ZendeskConnector } from "../zendesk.js";

// `getOAuthConfig` is `protected` on BaseConnector. Tests need to call
// it to assert the contract; cast through a minimal structural type.
type WithGetOAuthConfig = { getOAuthConfig(): unknown };

const wave2Connectors = [
  { name: "Confluence", ctor: ConfluenceConnector },
  { name: "Datadog", ctor: DatadogConnector },
  { name: "HubSpot", ctor: HubSpotConnector },
  { name: "Intercom", ctor: IntercomConnector },
  { name: "Jira", ctor: JiraConnector },
  { name: "Notion", ctor: NotionConnector },
  { name: "Stripe", ctor: StripeConnector },
  { name: "Zendesk", ctor: ZendeskConnector },
] as const;

describe("Wave-2 connectors — no OAuth refresh contract", () => {
  for (const { name, ctor } of wave2Connectors) {
    it(`${name}.getOAuthConfig() returns null (API-token / Basic-auth only)`, () => {
      const instance = new ctor() as unknown as WithGetOAuthConfig;
      expect(instance.getOAuthConfig()).toBeNull();
    });
  }
});
