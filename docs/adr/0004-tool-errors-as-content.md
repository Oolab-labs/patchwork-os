# ADR-0004: Tool Errors as Content Blocks vs JSON-RPC Errors

**Status:** Accepted
**Date:** 2026-03-19

## Context

When a tool execution fails (file not found, git command error, invalid input after schema validation), the bridge must communicate the failure back to the client. There are two mechanisms:

1. **JSON-RPC error response** — `{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"..."}}`. Standard for protocol-level failures.

2. **Successful response with `isError: true`** — `{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"Error: file not found"}],"isError":true}}`. The response is technically successful at the protocol level, but the content indicates the tool failed.

Early implementations used JSON-RPC errors for everything. This caused two problems:

- **LLMs can't reason about JSON-RPC errors.** Claude Code treats JSON-RPC errors as infrastructure failures and may abort the entire tool sequence. With `isError` content, Claude reads the error message, understands what went wrong, and can retry with different parameters or try an alternative approach.

- **MCP spec compliance.** The Model Context Protocol specification explicitly states that tool execution errors should be returned as content with `isError: true`, reserving JSON-RPC error codes for protocol-level issues (parse error, method not found, rate limiting).

## Decision

Separate error handling into two tiers:

**Tier 1 — Protocol errors (`ErrorCodes`, JSON-RPC -32xxx):**
Used for issues the LLM cannot meaningfully act on:
- `-32700` Parse error (malformed JSON)
- `-32601` Method not found
- `-32602` Invalid params (AJV schema validation failure)
- `-32000` Rate limit exceeded
- `-32001` Session errors (not found, capacity reached)

**Tier 2 — Tool errors (`ToolErrorCodes`, `isError: true` in content):**
Used for failures the LLM can understand and potentially recover from:
- File not found, permission denied
- Git command failed (bad ref, merge conflict)
- Command execution error (non-zero exit code)
- Extension disconnected (for `extensionRequired` tools)

In code, tool handlers catch errors and return them as content:

```typescript
handler: async (args) => {
  try {
    const result = await doWork(args);
    return { content: [{ type: "text", text: result }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
};
```

Tool handlers must **never throw**. Uncaught exceptions are caught by the transport layer and converted to `isError` content as a safety net, but this path logs a warning.

## Consequences

**Positive:**
- LLMs can read error messages and adapt (retry with different args, try alternative tool, explain the issue to the user).
- Clean separation: protocol errors for infrastructure, content errors for tool logic.
- MCP spec compliant — interoperable with other MCP clients.

**Negative:**
- Contributors must remember: **never use JSON-RPC error codes for tool failures**. This is the most common mistake when adding new tools.
- Error content is free-form text — no structured error codes for programmatic handling by non-LLM clients. Mitigated by consistent error message prefixes.

**Audit rule:**
Grep for `ErrorCodes.` usage in `src/tools/` — it should appear only in the transport layer, never in individual tool handlers.
