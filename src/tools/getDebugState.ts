import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import { error, extensionRequired, successStructured } from "./utils.js";

export function createGetDebugStateTool(extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "getDebugState",
      extensionRequired: true,
      description:
        "VS Code debugger state: session info, paused location, call stack, locals. hasActiveSession=false if idle.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          hasActiveSession: { type: "boolean" as const },
          sessionId: { type: "string" as const },
          sessionName: { type: "string" as const },
          sessionType: { type: "string" as const },
          isPaused: { type: "boolean" as const },
          pausedAt: {
            type: "object" as const,
            properties: {
              file: { type: "string" as const },
              line: { type: "integer" as const },
              column: { type: "integer" as const },
            },
            required: ["file", "line", "column"],
          },
          callStack: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                id: { type: "integer" as const },
                name: { type: "string" as const },
                file: { type: "string" as const },
                line: { type: "integer" as const },
                column: { type: "integer" as const },
              },
              required: ["id", "name", "file", "line", "column"],
            },
          },
          scopes: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                name: { type: "string" as const },
                variables: {
                  type: "array" as const,
                  items: {
                    type: "object" as const,
                    properties: {
                      name: { type: "string" as const },
                      value: { type: "string" as const },
                      type: { type: "string" as const },
                    },
                    required: ["name", "value", "type"],
                  },
                },
              },
              required: ["name", "variables"],
            },
          },
          breakpoints: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                file: { type: "string" as const },
                line: { type: "integer" as const },
                condition: { type: "string" as const },
                enabled: { type: "boolean" as const },
              },
              required: ["file", "line", "enabled"],
            },
          },
        },
        required: ["hasActiveSession", "isPaused", "breakpoints"],
      },
    },
    async handler() {
      if (!extensionClient.isConnected()) {
        return extensionRequired("getDebugState");
      }
      try {
        const result = await extensionClient.getDebugState();
        if (result === null) {
          return successStructured({
            hasActiveSession: false,
            isPaused: false,
            breakpoints: [],
          });
        }
        return successStructured(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out getting debug state");
        }
        throw err;
      }
    },
  };
}
