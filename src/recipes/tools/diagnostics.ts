/**
 * Diagnostics tool — diagnostics.get
 *
 * Self-registering tool module for the recipe tool registry.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// diagnostics.get
// ============================================================================

registerTool({
  id: "diagnostics.get",
  namespace: "diagnostics",
  description:
    "Get diagnostic summary for a file URI (requires bridge connection; returns stub if unavailable).",
  paramsSchema: {
    type: "object",
    properties: {
      uri: {
        type: "string",
        description:
          "File URI to get diagnostics for (e.g., 'file:///path/to/file.ts')",
        default: "",
      },
      into: CommonSchemas.into,
    },
  },
  outputSchema: {
    type: "string",
    description:
      "Diagnostic summary string (errors, warnings count or detailed list)",
  },
  riskDefault: "low",
  isWrite: false,
  execute: async ({ params, deps }) => {
    const uri = String(params.uri ?? "");
    return deps.getDiagnostics(uri);
  },
});
