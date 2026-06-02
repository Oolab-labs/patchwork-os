/**
 * Registry ⇄ route parity guard.
 *
 * The shared connector registry (`src/connectors/connectorRegistry.ts`) is
 * the single source of truth the dashboard derives its connect / test /
 * delete allowlists from. If a connector declares `supports.connect`,
 * `supports.test`, or `supports.delete` but the bridge dispatcher
 * (`src/connectorRoutes.ts`) has no matching route literal, the dashboard
 * surfaces the connector and every call 404s end-to-end.
 *
 * That is exactly what happened to the 13 Wave 3/4 connectors (resend,
 * obsidian, todoist, vercel, paystack, pipedrive, caldiy, grafana,
 * posthog, cloudflare, circleci, woocommerce, supabase) and to jira (which
 * had routes but an empty `supports`). This text-level assertion fails the
 * build before that class of drift ships again.
 *
 * It is deliberately a string scan of the dispatcher source rather than a
 * live HTTP probe: it catches a missing route block regardless of whether
 * the connector module's handlers throw at runtime.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONNECTORS } from "../connectors/connectorRegistry.js";

const here = dirname(fileURLToPath(import.meta.url));
const routesSrc = readFileSync(join(here, "..", "connectorRoutes.ts"), "utf8");

describe("connector registry ⇄ bridge route parity", () => {
  for (const c of CONNECTORS) {
    if (c.supports.connect === true) {
      it(`${c.id}: registry declares connect → dispatcher has POST /connections/${c.id}/connect`, () => {
        expect(
          routesSrc,
          `connectorRoutes.ts is missing the /connections/${c.id}/connect route`,
        ).toContain(`/connections/${c.id}/connect`);
      });
    }
    if (c.supports.test === true) {
      it(`${c.id}: registry declares test → dispatcher has POST /connections/${c.id}/test`, () => {
        expect(
          routesSrc,
          `connectorRoutes.ts is missing the /connections/${c.id}/test route`,
        ).toContain(`/connections/${c.id}/test`);
      });
    }
    if (c.supports.delete === true) {
      it(`${c.id}: registry declares delete → dispatcher has DELETE /connections/${c.id}`, () => {
        // The DELETE literal is the bare `/connections/<id>` path string.
        // Assert it appears alongside a DELETE method guard so we don't
        // match the longer /connect or /test literals by prefix.
        const deletePattern = new RegExp(
          `parsedUrl\\.pathname === "/connections/${c.id}"[\\s\\S]{0,80}req\\.method === "DELETE"`,
        );
        expect(
          deletePattern.test(routesSrc),
          `connectorRoutes.ts is missing the DELETE /connections/${c.id} route`,
        ).toBe(true);
      });
    }
  }
});
