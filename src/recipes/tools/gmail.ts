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

async function gmailGetMessage(
  id: string,
  deps: {
    fetchFn?: import("../yamlRunner.js").FetchFn;
    getGmailToken?: () => Promise<string>;
  },
): Promise<string> {
  const errorResult = (msg: string): string =>
    JSON.stringify({ id, subject: "", body: "", links: [], error: msg });

  let token: string;
  try {
    if (!deps.getGmailToken) return errorResult("Gmail not connected");
    token = await deps.getGmailToken();
  } catch (err) {
    return errorResult(
      err instanceof Error ? err.message : "Gmail not connected",
    );
  }

  const fetch = deps.fetchFn || globalThis.fetch;
  const res = await fetch(
    `https://www.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!res.ok) return errorResult("Gmail API error");

  const data = (await res.json()) as {
    id: string;
    snippet?: string;
    payload?: {
      headers?: Array<{ name: string; value: string }>;
      body?: { data?: string };
      parts?: Array<{
        mimeType: string;
        body?: { data?: string };
        parts?: Array<{ mimeType: string; body?: { data?: string } }>;
      }>;
    };
  };

  const hdrs = data.payload?.headers ?? [];
  const subject = getHeader(hdrs, "Subject");

  function extractText(payload: NonNullable<typeof data.payload>): string {
    if (payload.body?.data) {
      return Buffer.from(payload.body.data, "base64url").toString("utf-8");
    }
    for (const part of payload.parts ?? []) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return Buffer.from(part.body.data, "base64url").toString("utf-8");
      }
      if (part.mimeType === "text/html" && part.body?.data) {
        return Buffer.from(part.body.data, "base64url").toString("utf-8");
      }
      for (const sub of part.parts ?? []) {
        if (sub.mimeType === "text/plain" && sub.body?.data) {
          return Buffer.from(sub.body.data, "base64url").toString("utf-8");
        }
      }
    }
    return data.snippet ?? "";
  }

  const body = data.payload ? extractText(data.payload) : (data.snippet ?? "");
  const links = [...body.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0]);

  return JSON.stringify({ id, subject, body: body.slice(0, 16_000), links });
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
// gmail.getMessage
// ============================================================================

registerTool({
  id: "gmail.getMessage",
  namespace: "gmail",
  description:
    "Fetch a single Gmail message by ID with full body text and extracted links.",
  paramsSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Gmail message ID" },
      into: CommonSchemas.into,
    },
    required: ["id"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      subject: { type: "string" },
      body: { type: "string" },
      links: { type: "array", items: { type: "string" } },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params, deps }) => {
    const id = String(params.id ?? "");
    return gmailGetMessage(id, deps);
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

// ============================================================================
// gmail.resolveMeetingNotes
// ============================================================================

registerTool({
  id: "gmail.resolveMeetingNotes",
  namespace: "gmail",
  description:
    "Takes gmail.search results and resolves the full meeting notes content for each email. For direct Meet summary emails, returns the body. For 'Notes by Gemini' emails with a linked Google Doc, fetches the full message body, extracts the docs.google.com URL, and retrieves the plain-text doc content. Returns a JSON array of { emailId, subject, source, content }.",
  paramsSchema: {
    type: "object",
    properties: {
      emails: {
        description:
          "Output of gmail.search: { count, messages: [{id, subject, from, date, snippet}] } or JSON string thereof.",
      },
      into: CommonSchemas.into,
    },
    required: ["emails"],
  },
  outputSchema: {
    type: "array",
    items: {
      type: "object",
      properties: {
        emailId: { type: "string" },
        subject: { type: "string" },
        source: { type: "string", enum: ["email", "drive"] },
        content: { type: "string" },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params, deps }) => {
    type EmailItem = {
      id: string;
      subject: string;
      snippet?: string;
    };

    let messages: EmailItem[] = [];
    try {
      const raw = params.emails;
      const parsed: unknown =
        typeof raw === "string" ? JSON.parse(raw as string) : raw;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "messages" in (parsed as object)
      ) {
        messages = (parsed as { messages: EmailItem[] }).messages ?? [];
      } else if (Array.isArray(parsed)) {
        messages = parsed as EmailItem[];
      }
    } catch {
      return JSON.stringify([]);
    }

    const results: Array<{
      emailId: string;
      subject: string;
      source: "email" | "drive";
      content: string;
    }> = [];

    for (const msg of messages) {
      const subject = msg.subject ?? "";
      const isGemini =
        /notes by gemini|document shared with you|shared a document|invited you to (?:edit|view|comment)/i.test(
          subject,
        ) ||
        /notes by gemini|docs\.google\.com\/document/i.test(msg.snippet ?? "");

      if (!isGemini) {
        // Direct Meet summary — use snippet as content
        results.push({
          emailId: msg.id,
          subject,
          source: "email",
          content: msg.snippet ?? "",
        });
        continue;
      }

      // Gemini notes — fetch full message to get Drive URL
      let driveUrl = "";
      try {
        const fullMsg = await gmailGetMessage(msg.id, deps);
        const parsed = JSON.parse(fullMsg) as {
          links?: string[];
          body?: string;
        };
        const links = parsed.links ?? [];
        driveUrl = links.find((l) => l.includes("docs.google.com")) ?? "";
        if (!driveUrl) {
          // Try extracting from body text
          const bodyMatch = /https?:\/\/docs\.google\.com\/[^\s"'<>]+/.exec(
            parsed.body ?? "",
          );
          driveUrl = bodyMatch?.[0] ?? "";
        }
      } catch {
        results.push({
          emailId: msg.id,
          subject,
          source: "email",
          content: msg.snippet ?? "",
        });
        continue;
      }

      if (!driveUrl) {
        results.push({
          emailId: msg.id,
          subject,
          source: "email",
          content: msg.snippet ?? "",
        });
        continue;
      }

      // Fetch the Drive doc
      try {
        if (!deps.getDriveToken) {
          results.push({
            emailId: msg.id,
            subject,
            source: "email",
            content: msg.snippet ?? "",
          });
          continue;
        }
        const token = await deps.getDriveToken();
        const { fetchDocContent, fetchDocName } = await import(
          "../../connectors/googleDrive.js"
        );
        const [content, docName] = await Promise.all([
          fetchDocContent(driveUrl, token),
          fetchDocName(driveUrl, token),
        ]);
        // Prepend the doc's display name as an H1 so the downstream parser
        // can pick it up as the meeting title even when the body is sparse
        // (e.g. an empty Gemini Notes doc generated before the meeting).
        const titledContent = docName ? `# ${docName}\n\n${content}` : content;
        results.push({
          emailId: msg.id,
          subject,
          source: "drive",
          content: titledContent,
        });
      } catch {
        results.push({
          emailId: msg.id,
          subject,
          source: "email",
          content: msg.snippet ?? "",
        });
      }
    }

    return JSON.stringify(results);
  },
});
