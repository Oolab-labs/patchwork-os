/** Structured JSON-RPC error codes for the bridge.
 *  Standard codes: https://spec.modelcontextprotocol.io/specification/2025-11-25/basic/transports/#error-handling
 */
export const ErrorCodes = {
  // JSON-RPC 2.0 standard codes
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // MCP-defined codes
  REQUEST_CANCELLED: -32800,
  CONTENT_TOO_LARGE: -32801,
  // Bridge-specific server codes (within reserved -32000 to -32099 range)
  TOOL_EXECUTION_FAILED: -32000,
  EXTENSION_DISCONNECTED: -32001,
  REQUEST_TIMEOUT: -32002,
  TOOL_NOT_FOUND: -32003,
  RATE_LIMIT_EXCEEDED: -32004,
} as const;
