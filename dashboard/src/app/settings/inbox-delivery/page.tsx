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
          <h1 className="editorial-h1 m-0">
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

      <aside className="idl-note">
        <strong className="idl-note-strong">Instructional for now.</strong>{" "}
        Patchwork ships with the delivery tools below (
        <code>http.post</code>, <code>im_send</code>, <code>email.send</code>) but
        does not yet expose a configure-and-test panel. Wire one channel via the
        snippet, then come back here once the management API ships to manage
        them in-app.
      </aside>

      <div className="idl-channel-grid">
        {CHANNELS.map((c) => {
          const open = openId === c.id;
          return (
            <button
              type="button"
              key={c.id}
              onClick={() => setOpenId(open ? null : c.id)}
              aria-expanded={open}
              aria-controls="inbox-delivery-setup-panel"
              className="idl-channel-btn"
              style={{
                border: open
                  ? `1px solid ${toneText(c.tone)}`
                  : "1px solid var(--line-2)",
                background: open ? toneBg(c.tone) : "var(--surface)",
              }}
            >
              <div
                className="idl-channel-name"
                style={{ color: toneText(c.tone) }}
              >
                <span
                  aria-hidden="true"
                  className="idl-channel-dot"
                  style={{ background: toneText(c.tone) }}
                />
                {c.name}
              </div>
              <div className="idl-channel-tagline">{c.tagline}</div>
              <div className="idl-channel-toggle">
                {open ? (
                  <>Hide setup<span aria-hidden="true"> ▴</span></>
                ) : (
                  <>Show setup<span aria-hidden="true"> ▾</span></>
                )}
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
            id="inbox-delivery-setup-panel"
            role="region"
            aria-label={`${channel.name} setup`}
            className="idl-setup-panel"
          >
            <div className="idl-setup-title">{channel.name} setup</div>
            <div className="idl-setup-desc">{channel.whenToPick}</div>
            <div className="idl-setup-snippet">
              <CodeBlock>{highlightYaml(channel.recipeSnippet)}</CodeBlock>
            </div>
            {channel.caveat && (
              <div className={`idl-setup-caveat${channel.docs ? " idl-setup-caveat-mb" : ""}`}>
                <span aria-hidden="true">⚠ </span>
                {channel.caveat}
              </div>
            )}
            {channel.docs && (
              <div className="idl-setup-docs">
                <a
                  href={channel.docs.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="idl-setup-docs-link"
                >
                  {channel.docs.label} ↗
                </a>
              </div>
            )}
          </div>
        );
      })()}

      <div className="idl-back-note">
        Already wired a channel?{" "}
        <Link href="/inbox" className="idl-back-link">
          Go back to your inbox →
        </Link>
      </div>
    </section>
  );
}
