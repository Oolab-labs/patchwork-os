/**
 * Gmail tools — gmail.fetch_unread, gmail.search, gmail.fetch_thread
 *
 * Self-registering tool module for the recipe tool registry.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";

async function gmailSearch(
  query: string,
  max: number,
  deps: {
    fetchFn?: import("../yamlRunner.js").FetchFn;
    getGmailToken?: () => Promise<string>;
  },
): Promise<string> {
  const errorResult = (msg: string): string =>
    JSON.stringify({ count: 0, messages: [], error: msg });

  let token: string;
  try {
    if (!deps.getGmailToken) {
      return errorResult("Gmail not connected");
    }
    token = await deps.getGmailToken();
  } catch (err) {
    return errorResult(
      err instanceof Error ? err.message : "Gmail not connected",
    );
  }

  const fetch = deps.fetchFn || globalThis.fetch;

  try {
    // 1. List messages
    const listUrl = `https://www.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${max}`;
    const listRes = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!listRes.ok) {
      return errorResult("Gmail API error");
    }

    const listJson = (await listRes.json()) as {
      messages?: Array<{ id: string; threadId: string }>;
    };
    const ids = listJson.messages ?? [];

    // 2. Fetch details for each message
    const messages = await Promise.all(
      ids.slice(0, max).map(async (m) => {
        const detailUrl = `https://www.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject,From,Date`;
        const detailRes = await fetch(detailUrl, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!detailRes.ok) {
          return { id: m.id, subject: "", from: "", date: "", snippet: "" };
        }
        const detail = (await detailRes.json()) as {
          id: string;
          snippet?: string;
          payload?: { headers?: Array<{ name: string; value: string }> };
        };
        const hdrs = detail.payload?.headers ?? [];
        return {
          id: detail.id,
          subject: getHeader(hdrs, "Subject"),
          from: getHeader(hdrs, "From"),
          date: getHeader(hdrs, "Date"),
          snippet: cleanSnippet(detail.snippet ?? ""),
        };
      }),
    );

    return JSON.stringify({ count: messages.length, messages });
  } catch {
    return errorResult("Gmail fetch failed");
  }
}

function getHeader(
  headers: Array<{ name: string; value: string }>,
  name: string,
): string {
  return (
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ??
    ""
  );
}

function cleanSnippet(raw: string): string {
  return raw
    .replace(/[\u00AD\u200B-\u200F\u2060\uFEFF]/g, "")
    .replace(/(\s)\s+/g, "$1")
    .trim()
    .slice(0, 200);
}

async function gmailFetchThread(
  id: string,
  deps: {
    fetchFn?: import("../yamlRunner.js").FetchFn;
    getGmailToken?: () => Promise<string>;
  },
): Promise<string> {
  const errorResult = (msg: string): string =>
    JSON.stringify({ subject: "", messages: [], error: msg });

  let token: string;
  try {
    if (!deps.getGmailToken) {
      return errorResult("Gmail not connected");
    }
    token = await deps.getGmailToken();
  } catch (err) {
    return errorResult(
      err instanceof Error ? err.message : "Gmail not connected",
    );
  }

  const fetch = deps.fetchFn || globalThis.fetch;
  const res = await fetch(
    `https://www.googleapis.com/gmail/v1/users/me/threads/${id}?format=metadata`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!res.ok) {
    return errorResult(`Gmail API error`);
  }

  const data = await res.json();
  const headers = data.messages?.[0]?.payload?.headers ?? [];
  const subject =
    headers.find((h: { name: string }) => h.name === "Subject")?.value ?? "";

  return JSON.stringify({
    subject,
    messages: data.messages ?? [],
  });
}

function sinceToGmailQuery(since: string): string {
  if (since.includes("d")) {
    return `${since.replace("d", "")}d`;
  }
  if (since.includes("h")) {
    return `${since.replace("h", "")}h`;
  }
  return "1d";
}

// ============================================================================
// gmail.fetch_unread
// ============================================================================

registerTool({
  id: "gmail.fetch_unread",
  namespace: "gmail",
  description: "Fetch unread Gmail messages since a time expression.",
  paramsSchema: {
    type: "object",
    properties: {
      since: CommonSchemas.since,
      max: {
        ...CommonSchemas.max,
        maximum: 50,
      },
      into: CommonSchemas.into,
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      count: { type: "number" },
      messages: { type: "array" },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params, deps }) => {
    const since = String(params.since ?? "24h");
    const max = Math.min(typeof params.max === "number" ? params.max : 20, 50);
    const query = `is:unread newer_than:${sinceToGmailQuery(since)}`;
    return gmailSearch(query, max, deps);
  },
});

// ============================================================================
// gmail.search
// ============================================================================

registerTool({
  id: "gmail.search",
  namespace: "gmail",
  description: "Search Gmail with a custom query string.",
  paramsSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Gmail search query (same syntax as Gmail search bar)",
      },
      max: {
        ...CommonSchemas.max,
        maximum: 50,
      },
      into: CommonSchemas.into,
    },
    required: ["query"],
  },
  outputSchema: {
    type: "object",
    properties: {
      count: { type: "number" },
      messages: { type: "array" },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params, deps }) => {
    const query = String(params.query ?? "");
    const max = Math.min(typeof params.max === "number" ? params.max : 10, 50);
    return gmailSearch(query, max, deps);
  },
});

// ============================================================================
// gmail.fetch_thread
// ============================================================================

registerTool({
  id: "gmail.fetch_thread",
  namespace: "gmail",
  description: "Fetch a specific Gmail thread by ID.",
  paramsSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Gmail thread ID",
      },
      into: CommonSchemas.into,
    },
    required: ["id"],
  },
  outputSchema: {
    type: "object",
    properties: {
      subject: { type: "string" },
      messages: { type: "array" },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params, deps }) => {
    const id = String(params.id ?? "");
    return gmailFetchThread(id, deps);
  },
});
