/**
 * Connector logos, bundled.
 *
 * These used to be <img> URLs on cdn.simpleicons.org, cdn.jsdelivr.net and
 * monday.com, fetched on every connections-page view — telling three outside
 * parties the viewer's address and which services this workspace connects
 * (Private/52 LOW). They now come from `simple-icons`, PINNED at 13.21.0
 * (CC0-1.0): the last major that still carries every brand used here —
 * slack, salesforce, twilio and sendgrid were removed after it, which is why
 * the old map mixed two CDN versions. Rendered inline; nothing is fetched.
 *
 * A connector with no entry (monday, paystack, pipedrive) falls back to its
 * initials, as before.
 */

import type { SimpleIcon } from "simple-icons";
import {
  siAirtable,
  siAsana,
  siCaldotcom,
  siCircleci,
  siCloudflare,
  siConfluence,
  siDatadog,
  siDiscord,
  siElasticsearch,
  siFigma,
  siGithub,
  siGitlab,
  siGmail,
  siGooglecalendar,
  siGoogledocs,
  siGoogledrive,
  siGrafana,
  siHubspot,
  siIntercom,
  siJira,
  siLinear,
  siMongodb,
  siNotion,
  siObsidian,
  siPagerduty,
  siPostgresql,
  siPosthog,
  siRedis,
  siResend,
  siSalesforce,
  siSendgrid,
  siSentry,
  siShopify,
  siSlack,
  siSnowflake,
  siStripe,
  siSupabase,
  siTelegram,
  siTodoist,
  siTwilio,
  siVercel,
  siWebflow,
  siWoocommerce,
  siZendesk,
} from "simple-icons";

const LOGOS: Record<string, SimpleIcon> = {
  jira: siJira,
  notion: siNotion,
  pagerduty: siPagerduty,
  telegram: siTelegram,
  "google-docs": siGoogledocs,
  confluence: siConfluence,
  linear: siLinear,
  slack: siSlack,
  discord: siDiscord,
  zendesk: siZendesk,
  github: siGithub,
  gitlab: siGitlab,
  asana: siAsana,
  hubspot: siHubspot,
  salesforce: siSalesforce,
  intercom: siIntercom,
  gmail: siGmail,
  "google-calendar": siGooglecalendar,
  "google-drive": siGoogledrive,
  datadog: siDatadog,
  stripe: siStripe,
  sentry: siSentry,
  figma: siFigma,
  airtable: siAirtable,
  webflow: siWebflow,
  shopify: siShopify,
  twilio: siTwilio,
  sendgrid: siSendgrid,
  snowflake: siSnowflake,
  postgres: siPostgresql,
  mongodb: siMongodb,
  redis: siRedis,
  elasticsearch: siElasticsearch,
  resend: siResend,
  obsidian: siObsidian,
  todoist: siTodoist,
  vercel: siVercel,
  caldiy: siCaldotcom,
  grafana: siGrafana,
  posthog: siPosthog,
  cloudflare: siCloudflare,
  circleci: siCircleci,
  woocommerce: siWoocommerce,
  supabase: siSupabase,
};

export function connectorLogo(
  id: string,
): { title: string; path: string } | null {
  const icon = Object.hasOwn(LOGOS, id) ? LOGOS[id] : undefined;
  return icon ? { title: icon.title, path: icon.path } : null;
}
