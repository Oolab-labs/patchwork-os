import type { McpTransport } from "../transport.js";
import { successStructured } from "./utils.js";

export function createGetSessionUsageTool(transport: McpTransport) {
  return {
    schema: {
      name: "getSessionUsage",
      description:
        "Token usage estimate for this session: schema size, call counts, largest tool results.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {},
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          callCount: { type: "integer" },
          errorCount: { type: "integer" },
          approvalRejectionCount: { type: "integer" },
          schemaTokenEstimate: { type: ["integer", "null"] },
          cacheWarmed: { type: "boolean" },
          largestResults: {
            type: "array",
            items: {
              type: "object",
              properties: {
                tool: { type: "string" },
                sizeChars: { type: "integer" },
              },
              required: ["tool", "sizeChars"],
            },
          },
          sessionDurationMs: { type: "integer" },
        },
        required: [
          "callCount",
          "errorCount",
          "approvalRejectionCount",
          "schemaTokenEstimate",
          "cacheWarmed",
          "largestResults",
          "sessionDurationMs",
        ],
      },
    },
    handler: async () => {
      const stats = transport.getStats();
      const schemaCacheSize = transport.getWireSchemaCacheSize();
      return successStructured({
        callCount: stats.callCount,
        errorCount: stats.errorCount,
        approvalRejectionCount: stats.approvalRejectionCount,
        schemaTokenEstimate:
          schemaCacheSize !== null ? Math.round(schemaCacheSize / 4) : null,
        cacheWarmed: schemaCacheSize !== null,
        largestResults: transport.getTopResultSizes(10),
        sessionDurationMs: Date.now() - stats.startedAt,
      });
    },
  };
}
