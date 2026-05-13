"use client";

import { useState } from "react";
import Link from "next/link";
import { BackLink, CodeBlock, highlightYaml } from "@/components/patchwork";

/**
 * /settings/inbox-delivery — explains how to push inbox items to a
 * user's phone (iMessage / ntfy / webhook). Today this is an
 * instructional page: the bridge ships with recipe steps that handle
 * each delivery channel, but there is no first-class "delivery
 * channels" CRUD endpoint to manage them via the dashboard. Rather
 * than block this PR on a backend change, the page walks the user
 * through the per-channel setup pattern with copy-paste recipe
 * snippets. When a management API lands, this page swaps out for a
 * real configure-and-test panel; the URL stays the same so the
 * discovery cards on /inbox keep working.
 */

type ChannelId = "ntfy" | "imessage" | "webhook" | "email";

interface Channel {
  id: ChannelId;
  name: string;
  tagline: string;
  whenToPick: string;
  recipeSnippet: string;
  /** Tone for the channel card accent. */
  tone: "accent" | "info" | "ok" | "warn";
  /** External docs / setup link, if any. */
  docs?: { href: string; label: string };
  /** Per-channel caveat / footnote, if any. */
  caveat?: string;
}

const CHANNELS: Channel[] = [
  {
    id: "ntfy",
    name: "ntfy push",
    tagline:
      "Free, open-source push to iOS/Android via the ntfy.sh app. Lowest-friction option.",
    whenToPick:
      "Pick this when you want instant notifications and don't want to manage Apple-ID-specific quirks.",
    tone: "accent",
    recipeSnippet: `# Append to any recipe that produces a brief:
- id: notify_phone
  type: tool
  tool: http.post
  with:
    url: https://ntfy.sh/<your-topic>
    body: \${steps.brief.output}
    headers:
      Title: "Patchwork morning brief"
      Priority: "default"
      Tags: "newspaper"`,
    docs: {
      href: "https://ntfy.sh/docs/publish/",
      label: "ntfy publish docs",
    },
    caveat:
      "Pick an unguessable topic name (e.g. UUID slug) — ntfy topics are public if discovered.",
  },
  {
    id: "imessage",
    name: "iMessage",
    tagline:
      "Send to a phone number or Apple ID via AppleScript. Works on macOS only.",
    whenToPick:
      "Pick this when the recipient is on iPhone and you want delivery to feel native.",
    tone: "ok",
    recipeSnippet: `# Append to any recipe:
- id: notify_imessage
  type: tool
  tool: im_send
  with:
    to: "you@example.com"     # Apple ID or phone number
    body: \${steps.brief.output}`,
    caveat:
      "macOS Sequoia tightened TCC permissions — ad-hoc helper apps stopped working in mid-2024. " +
      "If im_send fails silently, fall back to ntfy.",
  },
  {
    id: "webhook",
    name: "HTTP webhook",
    tagline:
      "POST to any URL. Wire it to Slack, Discord, Telegram, your own server — anything that accepts JSON.",
    whenToPick:
      "Pick this when you already have a notification system you trust (Slack, Telegram bot, etc.).",
    tone: "info",
    recipeSnippet: `# Append to any recipe:
- id: notify_webhook
  type: tool
  tool: http.post
  with:
    url: https://hooks.slack.com/services/T.../B.../...
    body: { text: \${steps.brief.output} }
    headers:
      Content-Type: application/json`,
    docs: {
      href: "https://api.slack.com/messaging/webhooks",
      label: "Slack incoming webhooks",
    },
  },
  {
    id: "email",
    name: "Email",
    tagline:
      "Send to any mailbox via SMTP. Higher latency than push but useful for archival.",
    whenToPick:
      "Pick this when you want the brief in your inbox-of-inboxes alongside everything else.",
    tone: "warn",
    recipeSnippet: `# Append to any recipe:
- id: notify_email
  type: tool
  tool: email.send
  with:
    to: "you@example.com"
    subject: "Patchwork morning brief"
    body: \${steps.brief.output}`,
    caveat:
      "Requires SMTP credentials in your bridge env vars. See docs for the supported providers.",
  },
];

function toneBg(tone: Channel["tone"]): string {
  switch (tone) {
    case "accent":
      return "color-mix(in srgb, var(--accent) 18%, transparent)";
    case "info":
      return "color-mix(in srgb, var(--info, var(--blue, #5b8def)) 18%, transparent)";
    case "ok":
      return "color-mix(in srgb, var(--ok) 18%, transparent)";
    case "warn":
      return "color-mix(in srgb, var(--amber, var(--warn)) 18%, transparent)";
  }
}

function toneText(tone: Channel["tone"]): string {
  switch (tone) {
    case "accent":
      return "var(--accent)";
    case "info":
      return "var(--info, var(--blue, #5b8def))";
    case "ok":
      return "var(--ok)";
    case "warn":
      return "var(--amber, var(--warn))";
  }
}

export default function InboxDeliveryPage() {
  const [openId, setOpenId] = useState<ChannelId | null>("ntfy");

  return (
    <section>
      <div className="page-head">
        <div>
          <BackLink href="/settings" label="Settings" />
          <h1 className="editorial-h1" style={{ margin: 0 }}>
            Inbox delivery —{" "}
            <span className="accent">
              push briefs to where you actually are.
            </span>
          </h1>
          <div className="editorial-sub">
            Four supported channels. Pick one, append the snippet to any
            recipe that produces a brief, restart your bridge.
          </div>
        </div>
      </div>

      <aside
        role="note"
        style={{
          marginBottom: 18,
          padding: "12px 16px",
          background: "color-mix(in srgb, var(--dot-muted) 8%, var(--surface))",
          border: "1px solid var(--line-2)",
          borderRadius: "var(--r-2)",
          fontSize: "var(--fs-s)",
          color: "var(--ink-2)",
          lineHeight: 1.5,
        }}
      >
        <strong style={{ color: "var(--ink-1)" }}>Instructional for now.</strong>{" "}
        Patchwork ships with the delivery tools below (
        <code>http.post</code>, <code>im_send</code>, <code>email.send</code>) but
        does not yet expose a configure-and-test panel. Wire one channel via the
        snippet, then come back here once the management API ships to manage
        them in-app.
      </aside>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: 14,
        }}
      >
        {CHANNELS.map((c) => {
          const open = openId === c.id;
          return (
            <button
              type="button"
              key={c.id}
              onClick={() => setOpenId(open ? null : c.id)}
              aria-expanded={open}
              style={{
                textAlign: "left",
                padding: "14px 16px",
                borderRadius: "var(--r-3)",
                border: open
                  ? `1px solid ${toneText(c.tone)}`
                  : "1px solid var(--line-2)",
                background: open
                  ? toneBg(c.tone)
                  : "var(--surface)",
                cursor: "pointer",
                display: "flex",
                flexDirection: "column",
                gap: 6,
                color: "inherit",
                transition: "background 120ms ease, border-color 120ms ease",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontWeight: 700,
                  fontFamily: "var(--font-mono)",
                  color: toneText(c.tone),
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: toneText(c.tone),
                  }}
                />
                {c.name}
              </div>
              <div style={{ fontSize: "var(--fs-s)", color: "var(--ink-1)" }}>
                {c.tagline}
              </div>
              <div style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)" }}>
                {open ? "Hide setup ▴" : "Show setup ▾"}
              </div>
            </button>
          );
        })}
      </div>

      {openId && (() => {
        const channel = CHANNELS.find((c) => c.id === openId);
        if (!channel) return null;
        return (
          <div
            style={{
              marginTop: 18,
              padding: "16px 18px",
              border: "1px solid var(--line-2)",
              borderRadius: "var(--r-3)",
              background: "var(--surface)",
            }}
          >
            <div
              style={{
                fontSize: "var(--fs-m)",
                fontWeight: 700,
                color: "var(--ink-0)",
                marginBottom: 4,
              }}
            >
              {channel.name} setup
            </div>
            <div
              style={{
                fontSize: "var(--fs-s)",
                color: "var(--ink-2)",
                marginBottom: 12,
              }}
            >
              {channel.whenToPick}
            </div>
            <div style={{ marginBottom: 12 }}>
              <CodeBlock>{highlightYaml(channel.recipeSnippet)}</CodeBlock>
            </div>
            {channel.caveat && (
              <div
                style={{
                  fontSize: "var(--fs-xs)",
                  color: "var(--amber, var(--warn))",
                  background: "color-mix(in srgb, var(--amber, var(--warn)) 8%, transparent)",
                  padding: "8px 10px",
                  borderRadius: "var(--r-2)",
                  marginBottom: channel.docs ? 10 : 0,
                }}
              >
                ⚠ {channel.caveat}
              </div>
            )}
            {channel.docs && (
              <div style={{ fontSize: "var(--fs-s)" }}>
                <a
                  href={channel.docs.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "var(--accent)", textDecoration: "none", fontWeight: 600 }}
                >
                  {channel.docs.label} ↗
                </a>
              </div>
            )}
          </div>
        );
      })()}

      <div
        style={{
          marginTop: 22,
          padding: "14px 16px",
          borderRadius: "var(--r-2)",
          border: "1px dashed var(--line-2)",
          fontSize: "var(--fs-s)",
          color: "var(--ink-2)",
        }}
      >
        Already wired a channel?{" "}
        <Link
          href="/inbox"
          style={{ color: "var(--accent)", textDecoration: "none", fontWeight: 600 }}
        >
          Go back to your inbox →
        </Link>
      </div>
    </section>
  );
}
