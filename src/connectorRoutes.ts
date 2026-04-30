/**
 * Connector route dispatcher — extracted from src/server.ts.
 *
 * Owns every `/connections/*` HTTP endpoint (auth start / OAuth callback /
 * test ping / disconnect / connect-with-body) for the 18 supported
 * connectors. Server.ts delegates with a single `tryHandleConnectorRoute`
 * call, collapsing ~1090 lines of route boilerplate into one line at the
 * call site.
 *
 * Mechanical lift — no behavior change:
 *   - The handler bodies are byte-identical to the original block save for
 *     wrapping the few non-IIFE calls (slack-auth, slack-disconnect,
 *     notion-disconnect, confluence-disconnect, zendesk-disconnect,
 *     intercom-disconnect, hubspot-test, hubspot-disconnect, datadog-
 *     disconnect, stripe-test, stripe-disconnect) in `void (async()=>...)()`
 *     so this module is sync (returns boolean rather than Promise<boolean>).
 *   - The microtask delay this introduces is invisible to clients — the
 *     parent request handler `return`s on a true result either way, and
 *     `res.end()` has always been async.
 *
 * Out of scope (deferred): the connector OAuth-callback routes that live up
 * at server.ts lines 590-720 are NOT moved here. They run inside the OAuth
 * authentication flow and have ordering constraints with bearer-auth gating;
 * a follow-up PR can consolidate them once we've verified the seam holds.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Try to handle a `/connections/*` route. Returns true if the route was
 * dispatched (caller should `return` from the request handler), false if
 * no route matched (caller should fall through to other route checks).
 *
 * The actual response is written asynchronously inside an IIFE; this
 * function returns synchronously as soon as the route is recognized.
 */
export function tryHandleConnectorRoute(
  req: IncomingMessage,
  res: ServerResponse,
  parsedUrl: URL,
): boolean {
  // ── Gmail / Connections endpoints ───────────────────────────────────────
  if (parsedUrl.pathname === "/connections" && req.method === "GET") {
    void (async () => {
      const { handleConnectionsList } = await import("./connectors/gmail.js");
      const result = await handleConnectionsList();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/gmail/auth" &&
    req.method === "GET"
  ) {
    void (async () => {
      const { handleGmailAuthRedirect } = await import("./connectors/gmail.js");
      const result = handleGmailAuthRedirect();
      if (result.redirect) {
        res.writeHead(302, { Location: result.redirect });
        res.end();
      } else {
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      }
    })();
    return true;
  }
  if (parsedUrl.pathname === "/connections/gmail" && req.method === "DELETE") {
    void (async () => {
      const { handleGmailDisconnect } = await import("./connectors/gmail.js");
      const result = await handleGmailDisconnect();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/gmail/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      const { handleGmailTest } = await import("./connectors/gmail.js");
      const result = await handleGmailTest();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }

  // ── GitHub MCP connector routes ─────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/github/auth" &&
    req.method === "GET"
  ) {
    void (async () => {
      const { handleGithubAuthorize } = await import("./connectors/github.js");
      const result = await handleGithubAuthorize();
      if (result.redirect) {
        res.writeHead(302, { Location: result.redirect });
        res.end();
      } else {
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/github/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      const { handleGithubTest } = await import("./connectors/github.js");
      const result = await handleGithubTest();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }
  if (parsedUrl.pathname === "/connections/github" && req.method === "DELETE") {
    void (async () => {
      const { handleGithubDisconnect } = await import("./connectors/github.js");
      const result = await handleGithubDisconnect();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }

  // ── Sentry MCP connector routes ─────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/sentry/auth" &&
    req.method === "GET"
  ) {
    void (async () => {
      const { handleSentryAuthorize } = await import("./connectors/sentry.js");
      const result = await handleSentryAuthorize();
      if (result.redirect) {
        res.writeHead(302, { Location: result.redirect });
        res.end();
      } else {
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/sentry/callback" &&
    req.method === "GET"
  ) {
    void (async () => {
      const { handleSentryCallback } = await import("./connectors/sentry.js");
      const code = parsedUrl.searchParams.get("code");
      const state = parsedUrl.searchParams.get("state");
      const error = parsedUrl.searchParams.get("error");
      const result = await handleSentryCallback(code, state, error);
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/sentry/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      const { handleSentryTest } = await import("./connectors/sentry.js");
      const result = await handleSentryTest();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }
  if (parsedUrl.pathname === "/connections/sentry" && req.method === "DELETE") {
    void (async () => {
      const { handleSentryDisconnect } = await import("./connectors/sentry.js");
      const result = await handleSentryDisconnect();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }

  // ── Linear MCP connector routes ─────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/linear/auth" &&
    req.method === "GET"
  ) {
    void (async () => {
      const { handleLinearAuthorize } = await import("./connectors/linear.js");
      const result = await handleLinearAuthorize();
      if (result.redirect) {
        res.writeHead(302, { Location: result.redirect });
        res.end();
      } else {
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/linear/callback" &&
    req.method === "GET"
  ) {
    void (async () => {
      const { handleLinearCallback } = await import("./connectors/linear.js");
      const code = parsedUrl.searchParams.get("code");
      const state = parsedUrl.searchParams.get("state");
      const error = parsedUrl.searchParams.get("error");
      const result = await handleLinearCallback(code, state, error);
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/linear/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      const { handleLinearTest } = await import("./connectors/linear.js");
      const result = await handleLinearTest();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }
  if (parsedUrl.pathname === "/connections/linear" && req.method === "DELETE") {
    void (async () => {
      const { handleLinearDisconnect } = await import("./connectors/linear.js");
      const result = await handleLinearDisconnect();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }

  // ── Slack connector routes ──────────────────────────────────────
  if (
    (parsedUrl.pathname === "/connections/slack/auth" ||
      parsedUrl.pathname === "/connections/slack/authorize") &&
    req.method === "GET"
  ) {
    void (async () => {
      const { handleSlackAuthorize } = await import("./connectors/slack.js");
      const result = handleSlackAuthorize();
      if (result.redirect) {
        res.writeHead(302, { Location: result.redirect });
        res.end();
      } else {
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/slack/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      const { handleSlackTest } = await import("./connectors/slack.js");
      const result = await handleSlackTest();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }
  if (parsedUrl.pathname === "/connections/slack" && req.method === "DELETE") {
    void (async () => {
      const { handleSlackDisconnect } = await import("./connectors/slack.js");
      const result = handleSlackDisconnect();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }

  // ── Discord connector routes ───────────────────────────────────
  if (
    (parsedUrl.pathname === "/connections/discord/auth" ||
      parsedUrl.pathname === "/connections/discord/authorize") &&
    req.method === "GET"
  ) {
    void (async () => {
      const { handleDiscordAuthorize } = await import(
        "./connectors/discord.js"
      );
      const result = handleDiscordAuthorize();
      if (result.redirect) {
        res.writeHead(302, { Location: result.redirect });
        res.end();
      } else {
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/discord/callback" &&
    req.method === "GET"
  ) {
    void (async () => {
      const { handleDiscordCallback } = await import("./connectors/discord.js");
      const code = parsedUrl.searchParams.get("code");
      const state = parsedUrl.searchParams.get("state");
      const error = parsedUrl.searchParams.get("error");
      const result = await handleDiscordCallback(code, state, error);
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "text/html",
      });
      res.end(result.body);
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/discord/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      const { handleDiscordTest } = await import("./connectors/discord.js");
      const result = await handleDiscordTest();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/discord" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      const { handleDiscordDisconnect } = await import(
        "./connectors/discord.js"
      );
      const result = await handleDiscordDisconnect();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }

  // ── Asana connector routes ─────────────────────────────────────
  if (
    (parsedUrl.pathname === "/connections/asana/auth" ||
      parsedUrl.pathname === "/connections/asana/authorize") &&
    req.method === "GET"
  ) {
    void (async () => {
      const { handleAsanaAuthorize } = await import("./connectors/asana.js");
      const result = handleAsanaAuthorize();
      if (result.redirect) {
        res.writeHead(302, { Location: result.redirect });
        res.end();
      } else {
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/asana/callback" &&
    req.method === "GET"
  ) {
    void (async () => {
      const { handleAsanaCallback } = await import("./connectors/asana.js");
      const code = parsedUrl.searchParams.get("code");
      const state = parsedUrl.searchParams.get("state");
      const error = parsedUrl.searchParams.get("error");
      const result = await handleAsanaCallback(code, state, error);
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "text/html",
      });
      res.end(result.body);
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/asana/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      const { handleAsanaTest } = await import("./connectors/asana.js");
      const result = await handleAsanaTest();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }
  if (parsedUrl.pathname === "/connections/asana" && req.method === "DELETE") {
    void (async () => {
      const { handleAsanaDisconnect } = await import("./connectors/asana.js");
      const result = await handleAsanaDisconnect();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }

  // ── GitLab connector routes ────────────────────────────────────
  if (
    (parsedUrl.pathname === "/connections/gitlab/auth" ||
      parsedUrl.pathname === "/connections/gitlab/authorize") &&
    req.method === "GET"
  ) {
    void (async () => {
      const { handleGitLabAuthorize } = await import("./connectors/gitlab.js");
      const result = handleGitLabAuthorize();
      if (result.redirect) {
        res.writeHead(302, { Location: result.redirect });
        res.end();
      } else {
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/gitlab/callback" &&
    req.method === "GET"
  ) {
    void (async () => {
      const { handleGitLabCallback } = await import("./connectors/gitlab.js");
      const code = parsedUrl.searchParams.get("code");
      const state = parsedUrl.searchParams.get("state");
      const error = parsedUrl.searchParams.get("error");
      const result = await handleGitLabCallback(code, state, error);
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "text/html",
      });
      res.end(result.body);
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/gitlab/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      const { handleGitLabTest } = await import("./connectors/gitlab.js");
      const result = await handleGitLabTest();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }
  if (parsedUrl.pathname === "/connections/gitlab" && req.method === "DELETE") {
    void (async () => {
      const { handleGitLabDisconnect } = await import("./connectors/gitlab.js");
      const result = await handleGitLabDisconnect();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }

  // ── Notion routes ──────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/notion/connect" &&
    req.method === "POST"
  ) {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const { handleNotionConnect } = await import("./connectors/notion.js");
        const result = await handleNotionConnect(
          Buffer.concat(chunks).toString("utf-8"),
        );
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      })();
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/notion/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      const { handleNotionTest } = await import("./connectors/notion.js");
      const result = await handleNotionTest();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }
  if (parsedUrl.pathname === "/connections/notion" && req.method === "DELETE") {
    void (async () => {
      const { handleNotionDisconnect } = await import("./connectors/notion.js");
      const result = handleNotionDisconnect();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }

  // ── Confluence routes ───────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/confluence/connect" &&
    req.method === "POST"
  ) {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const { handleConfluenceConnect } = await import(
          "./connectors/confluence.js"
        );
        const result = await handleConfluenceConnect(
          Buffer.concat(chunks).toString("utf-8"),
        );
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      })();
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/confluence/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      const { handleConfluenceTest } = await import(
        "./connectors/confluence.js"
      );
      const result = await handleConfluenceTest();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/confluence" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      const { handleConfluenceDisconnect } = await import(
        "./connectors/confluence.js"
      );
      const result = handleConfluenceDisconnect();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }

  // ── Zendesk routes ──────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/zendesk/connect" &&
    req.method === "POST"
  ) {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const { handleZendeskConnect } = await import(
          "./connectors/zendesk.js"
        );
        const result = await handleZendeskConnect(
          Buffer.concat(chunks).toString("utf-8"),
        );
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      })();
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/zendesk/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      const { handleZendeskTest } = await import("./connectors/zendesk.js");
      const result = await handleZendeskTest();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/zendesk" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      const { handleZendeskDisconnect } = await import(
        "./connectors/zendesk.js"
      );
      const result = handleZendeskDisconnect();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }

  // ── Intercom routes ─────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/intercom/connect" &&
    req.method === "POST"
  ) {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const { handleIntercomConnect } = await import(
          "./connectors/intercom.js"
        );
        const result = await handleIntercomConnect(
          Buffer.concat(chunks).toString("utf-8"),
        );
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      })();
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/intercom/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      const { handleIntercomTest } = await import("./connectors/intercom.js");
      const result = await handleIntercomTest();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/intercom" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      const { handleIntercomDisconnect } = await import(
        "./connectors/intercom.js"
      );
      const result = handleIntercomDisconnect();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }

  // ── HubSpot routes ─────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/hubspot/connect" &&
    req.method === "POST"
  ) {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const { handleHubSpotConnect } = await import(
          "./connectors/hubspot.js"
        );
        const result = await handleHubSpotConnect(
          Buffer.concat(chunks).toString("utf-8"),
        );
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      })();
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/hubspot/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      const { handleHubSpotTest } = await import("./connectors/hubspot.js");
      const result = await handleHubSpotTest();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/hubspot" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      const { handleHubSpotDisconnect } = await import(
        "./connectors/hubspot.js"
      );
      const result = handleHubSpotDisconnect();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }

  // ── Datadog routes ─────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/datadog/connect" &&
    req.method === "POST"
  ) {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const { handleDatadogConnect } = await import(
          "./connectors/datadog.js"
        );
        const result = await handleDatadogConnect(
          Buffer.concat(chunks).toString("utf-8"),
        );
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      })();
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/datadog/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      const { handleDatadogTest } = await import("./connectors/datadog.js");
      const result = await handleDatadogTest();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/datadog" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      const { handleDatadogDisconnect } = await import(
        "./connectors/datadog.js"
      );
      const result = handleDatadogDisconnect();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }

  // ── PagerDuty routes ───────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/pagerduty/connect" &&
    req.method === "POST"
  ) {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const { handlePagerDutyConnect } = await import(
          "./connectors/pagerduty.js"
        );
        const result = await handlePagerDutyConnect(
          Buffer.concat(chunks).toString("utf-8"),
        );
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      })();
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/pagerduty/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      const { handlePagerDutyTest } = await import("./connectors/pagerduty.js");
      const result = await handlePagerDutyTest();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/pagerduty" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      const { handlePagerDutyDisconnect } = await import(
        "./connectors/pagerduty.js"
      );
      const result = handlePagerDutyDisconnect();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }

  // ── Stripe routes ───────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/stripe/connect" &&
    req.method === "POST"
  ) {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      void (async () => {
        const { handleStripeConnect } = await import("./connectors/stripe.js");
        const result = await handleStripeConnect(body);
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      })();
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/stripe/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      const { handleStripeTest } = await import("./connectors/stripe.js");
      const result = await handleStripeTest();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }
  if (parsedUrl.pathname === "/connections/stripe" && req.method === "DELETE") {
    void (async () => {
      const { handleStripeDisconnect } = await import("./connectors/stripe.js");
      const result = handleStripeDisconnect();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }

  // ── Google Calendar routes ──────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/google-calendar/auth" &&
    req.method === "GET"
  ) {
    void (async () => {
      const { handleCalendarAuthRedirect } = await import(
        "./connectors/googleCalendar.js"
      );
      const result = handleCalendarAuthRedirect();
      if (result.redirect) {
        res.writeHead(302, { Location: result.redirect });
        res.end();
      } else {
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/google-calendar/callback" &&
    req.method === "GET"
  ) {
    void (async () => {
      const { handleCalendarCallback } = await import(
        "./connectors/googleCalendar.js"
      );
      const code = parsedUrl.searchParams.get("code");
      const state = parsedUrl.searchParams.get("state");
      const error = parsedUrl.searchParams.get("error");
      const result = await handleCalendarCallback(code, state, error);
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/google-calendar/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      const { handleCalendarTest } = await import(
        "./connectors/googleCalendar.js"
      );
      const result = await handleCalendarTest();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/google-calendar" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      const { handleCalendarDisconnect } = await import(
        "./connectors/googleCalendar.js"
      );
      const result = await handleCalendarDisconnect();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }

  // ── Google Drive routes ─────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/google-drive/auth" &&
    req.method === "GET"
  ) {
    void (async () => {
      const { handleDriveAuthRedirect } = await import(
        "./connectors/googleDrive.js"
      );
      const result = handleDriveAuthRedirect();
      if (result.redirect) {
        res.writeHead(302, { Location: result.redirect });
        res.end();
      } else {
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/google-drive/callback" &&
    req.method === "GET"
  ) {
    void (async () => {
      const { handleDriveCallback } = await import(
        "./connectors/googleDrive.js"
      );
      const code = parsedUrl.searchParams.get("code");
      const state = parsedUrl.searchParams.get("state");
      const error = parsedUrl.searchParams.get("error");
      const result = await handleDriveCallback(code, state, error);
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/google-drive/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      const { handleDriveTest } = await import("./connectors/googleDrive.js");
      const result = await handleDriveTest();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/google-drive" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      const { handleDriveDisconnect } = await import(
        "./connectors/googleDrive.js"
      );
      const result = await handleDriveDisconnect();
      res.writeHead(result.status, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    })();
    return true;
  }

  return false;
}
