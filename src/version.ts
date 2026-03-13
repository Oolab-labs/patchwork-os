/** Shared protocol version between the bridge server and the VS Code extension.
 *  NOTE: This is the *protocol* version (the MCP handshake negotiation value),
 *  intentionally separate from the npm package version in package.json.
 *  Only bump this when the wire-format contract changes in a way that requires
 *  coordinated updates on both the bridge and the extension side.
 */
export const BRIDGE_PROTOCOL_VERSION = "1.1.0";
