/**
 * Tool registry loader — imports all tool modules to trigger self-registration.
 *
 * Import this file before using the registry to ensure all tools are registered.
 */

// Core tools
import "./file.js";
import "./git.js";
import "./diagnostics.js";
import "./http.js";
import "./fanOut.js";
import "./outcomes.js";

// Connector-based tools
import "./asana.js";
import "./gmail.js";
import "./googleDrive.js";
import "./github.js";
import "./gitlab.js";
import "./linear.js";
import "./calendar.js";
import "./slack.js";
import "./notion.js";
import "./confluence.js";
import "./zendesk.js";
import "./intercom.js";
import "./hubspot.js";
import "./datadog.js";
import "./discord.js";
import "./jira.js";
import "./pagerduty.js";
import "./sentry.js";
import "./stripe.js";
import "./docs.js";
import "./monday.js";
import "./salesforce.js";
import "./elasticsearch.js";
import "./postgres.js";
import "./redis.js";
import "./snowflake.js";
import "./mongodb.js";
import "./caldiy.js";
import "./cloudflare.js";
import "./figma.js";
import "./obsidian.js";
import "./paystack.js";
import "./supabase.js";
import "./webflow.js";
import "./woocommerce.js";
import "./circleci.js";
import "./grafana.js";
import "./pipedrive.js";
import "./posthog.js";
import "./shopify.js";
import "./todoist.js";
import "./airtable.js";
import "./resend.js";
import "./sendgrid.js";
import "./twilio.js";
import "./vercel.js";
import "./meetingNotes.js";

export type {
  RegisteredTool,
  ToolContext,
  ToolExecute,
  ToolMetadata,
} from "../toolRegistry.js";
// Re-export registry for convenience
export {
  CommonOutputSchemas,
  CommonSchemas,
  clearRegistry,
  executeTool,
  getNamespaces,
  getTool,
  hasTool,
  listTools,
  registerTool,
} from "../toolRegistry.js";
