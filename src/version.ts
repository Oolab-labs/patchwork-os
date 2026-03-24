import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const _require = createRequire(import.meta.url);
const _rootPkg = _require(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
) as { version: string; license?: string };

/** npm package version (e.g. "2.0.5") — used in the unauthenticated /ping response. */
export const PACKAGE_VERSION: string = _rootPkg.version;

/** License identifier from package.json (e.g. "MIT"). */
export const PACKAGE_LICENSE: string = _rootPkg.license ?? "MIT";

/** Shared protocol version between the bridge server and the VS Code extension.
 *  NOTE: This is the *protocol* version (the MCP handshake negotiation value),
 *  intentionally separate from the npm package version in package.json.
 *  Only bump this when the wire-format contract changes in a way that requires
 *  coordinated updates on both the bridge and the extension side.
 */
export const BRIDGE_PROTOCOL_VERSION = "1.1.0";
