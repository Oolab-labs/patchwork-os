/**
 * Tool registry loader — imports all tool modules to trigger self-registration.
 *
 * Import this file before using the registry to ensure all tools are registered.
 */

// Core tools
import "./file.js";
import "./git.js";
import "./diagnostics.js";

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
