/** Structured JSON-RPC error codes for the bridge.
 *  Standard codes: https://spec.modelcontextprotocol.io/specification/2025-11-25/basic/transports/#error-handling
 */
export const ErrorCodes = {
  // JSON-RPC 2.0 standard codes
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  // Bridge-specific server codes (within reserved -32000 to -32099 range)
  TOOL_NOT_FOUND: -32003,
  RATE_LIMIT_EXCEEDED: -32004,
} as const;

/**
 * Machine-readable error codes for tool-level errors (isError: true responses).
 * These appear in the `code` field of the JSON error object inside `content[0].text`.
 * JSON-RPC protocol errors use ErrorCodes above; these are for semantic tool errors.
 */
export const ToolErrorCodes = {
  FILE_NOT_FOUND: "file_not_found",
  PERMISSION_DENIED: "permission_denied",
  WORKSPACE_ESCAPE: "workspace_escape",
  EXTENSION_REQUIRED: "extension_required",
  TIMEOUT: "timeout",
  INVALID_ARGS: "invalid_args",
  GIT_ERROR: "git_error",
  EXTERNAL_COMMAND_FAILED: "external_command_failed",
  TASK_NOT_FOUND: "task_not_found",
  DRIVER_NOT_CONFIGURED: "driver_not_configured",
} as const;

export type ToolErrorCode =
  (typeof ToolErrorCodes)[keyof typeof ToolErrorCodes];
