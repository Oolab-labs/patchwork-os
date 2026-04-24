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
import "./gmail.js";
import "./github.js";
import "./linear.js";
import "./calendar.js";
import "./slack.js";
import "./notion.js";
import "./confluence.js";
import "./zendesk.js";
import "./intercom.js";
import "./hubspot.js";
import "./datadog.js";
import "./stripe.js";

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
