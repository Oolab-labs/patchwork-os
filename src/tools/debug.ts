import {
  type BreakpointSpec,
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import {
  error,
  extensionRequired,
  optionalInt,
  optionalString,
  requireArray,
  requireString,
  resolveFilePath,
  successStructured,
} from "./utils.js";

export function createEvaluateInDebuggerTool(extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "evaluateInDebugger",
      extensionRequired: true,
      description:
        "Evaluate an expression in the active debug session (REPL/watch). " +
        "The session must be paused at a breakpoint for variables to be in scope. ",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        required: ["expression"],
        properties: {
          expression: {
            type: "string" as const,
            description: "Expression to evaluate",
          },
          frameId: {
            type: "integer" as const,
            description:
              "Stack frame ID from getDebugState callStack (0=top frame)",
          },
          context: {
            type: "string" as const,
            enum: ["repl", "watch", "hover"],
            description: "Evaluation context (default: repl)",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          result: { type: "string" },
          type: { type: "string" },
          variablesReference: { type: "integer" },
        },
        required: ["result"],
      },
    },
    timeoutMs: 30_000,
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      if (!extensionClient.isConnected()) {
        return extensionRequired("evaluateInDebugger");
      }
      const expression = requireString(args, "expression", 10_000);
      const frameId = optionalInt(args, "frameId", 0, 10_000);
      const context = optionalString(args, "context") ?? "repl";
      try {
        const result = await extensionClient.evaluateInDebugger(
          expression,
          frameId,
          context,
          signal,
        );
        if (result === null)
          return error("No active debug session or evaluation failed");
        return successStructured(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out evaluating expression");
        }
        throw err;
      }
    },
  };
}

export function createSetDebugBreakpointsTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "setDebugBreakpoints",
      extensionRequired: true,
      description:
        "Set breakpoints in a file, replacing any existing ones. " +
        "Supports conditional breakpoints, logpoints, and hit-count conditions. ",
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        required: ["file", "breakpoints"],
        properties: {
          file: {
            type: "string" as const,
            description: "Absolute path to the file",
          },
          breakpoints: {
            type: "array" as const,
            description:
              "Breakpoints to set (replaces existing ones for this file)",
            items: {
              type: "object" as const,
              required: ["line"],
              properties: {
                line: {
                  type: "integer" as const,
                  description: "Line number (1-based)",
                },
                condition: {
                  type: "string" as const,
                  description: "Conditional expression",
                },
                logMessage: {
                  type: "string" as const,
                  description: "Logpoint message (no pause, just log)",
                },
                hitCondition: {
                  type: "string" as const,
                  description: "Hit condition (e.g. '>5')",
                },
              },
              additionalProperties: false as const,
            },
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          breakpoints: { type: "array" },
        },
        required: ["breakpoints"],
      },
    },
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      if (!extensionClient.isConnected()) {
        return extensionRequired("setDebugBreakpoints");
      }
      const file = resolveFilePath(requireString(args, "file"), workspace);
      const rawBreakpoints = requireArray(args, "breakpoints");
      const breakpoints: BreakpointSpec[] = rawBreakpoints.map((b, i) => {
        if (typeof b !== "object" || b === null)
          throw new Error(`breakpoints[${i}] must be an object`);
        const bp = b as Record<string, unknown>;
        if (typeof bp.line !== "number")
          throw new Error(`breakpoints[${i}].line must be a number`);
        return bp as unknown as BreakpointSpec;
      });
      const bps = breakpoints;
      try {
        const result = await extensionClient.setDebugBreakpoints(
          file,
          bps,
          signal,
        );
        if (result === null) return error("Failed to set breakpoints");
        return successStructured(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out setting breakpoints");
        }
        throw err;
      }
    },
  };
}

export function createStartDebuggingTool(extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "startDebugging",
      extensionRequired: true,
      description:
        "Start a debug session from .vscode/launch.json. Pass configName to select a configuration by name. ",
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        properties: {
          configName: {
            type: "string" as const,
            description: "Name of the launch configuration to use",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          started: { type: "boolean" },
          sessionId: { type: "string" },
        },
        required: ["started"],
      },
    },
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      if (!extensionClient.isConnected()) {
        return extensionRequired("startDebugging", [
          "Use runCommand with your test runner (vitest, jest, pytest) for test debugging",
          "Use runCommand with node --inspect for Node.js debugging",
        ]);
      }
      const configName = optionalString(args, "configName");
      try {
        const result = await extensionClient.startDebugging(configName, signal);
        if (result === null) return error("Failed to start debug session");
        return successStructured(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out starting debug session");
        }
        throw err;
      }
    },
  };
}

export function createStopDebuggingTool(extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "stopDebugging",
      extensionRequired: true,
      description:
        "Stop the active debug session. Has no effect if no session is running. ",
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          stopped: { type: "boolean" },
        },
        required: ["stopped"],
      },
    },
    async handler(_args: Record<string, unknown>, signal?: AbortSignal) {
      if (!extensionClient.isConnected()) {
        return extensionRequired("stopDebugging");
      }
      try {
        const result = await extensionClient.stopDebugging(signal);
        if (result === null) return error("Failed to stop debug session");
        return successStructured(result);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out stopping debug session");
        }
        throw err;
      }
    },
  };
}
