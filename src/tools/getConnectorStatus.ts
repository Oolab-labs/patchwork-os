import { getAllConnectorStatuses } from "../connectors/mcpOAuth.js";
import { successStructured } from "./utils.js";

export function createGetConnectorStatusTool() {
  return {
    schema: {
      name: "getConnectorStatus",
      description:
        "Returns the auth status of all MCP connectors (GitHub, Linear, Sentry). Shows whether each is connected, when the token expires, and whether re-authorization is needed.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {},
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          connectors: {
            type: "array",
            items: {
              type: "object",
              properties: {
                vendor: { type: "string" },
                connected: { type: "boolean" },
                expiresAt: { type: "number" },
                expiresInMs: { type: "number" },
                expiresInMinutes: { type: "number" },
                needsReauth: { type: "boolean" },
                profile: { type: "object" },
              },
              required: ["vendor", "connected", "needsReauth"],
            },
          },
        },
        required: ["connectors"],
      },
    },
    timeoutMs: 5_000,
    async handler(_args: Record<string, unknown>, _signal?: AbortSignal) {
      const statuses = getAllConnectorStatuses();
      return successStructured({
        connectors: statuses.map((s) => ({
          vendor: s.vendor,
          connected: s.connected,
          ...(s.expiresAt !== undefined && { expiresAt: s.expiresAt }),
          ...(s.expiresInMs !== undefined && {
            expiresInMs: s.expiresInMs,
            expiresInMinutes: Math.round(s.expiresInMs / 60_000),
          }),
          needsReauth: s.needsReauth,
          ...(s.profile && { profile: s.profile }),
        })),
      });
    },
  };
}
