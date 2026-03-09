import * as os from "os";
import * as path from "path";

export const RECONNECT_BASE_DELAY = 1000;
export const RECONNECT_MAX_DELAY = 30000;
export const SELECTION_DEBOUNCE = 400;
export const DIAGNOSTICS_DEBOUNCE = 500;
export const AI_COMMENTS_DEBOUNCE = 1000;
export const HANDLER_TIMEOUT = 30_000;
export const LOCK_DIR = path.join(
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
  "ide",
);
export const MAX_WATCHERS = 10;
export const MAX_TRACKED_TERMINALS = 10;
export const MAX_LINES_PER_TERMINAL = 5000;
export const MAX_OUTPUT_BYTES = 100 * 1024; // 100 KB per notebook cell output
export const MAX_HINTS = 500;
export const MAX_ALL_DIAGNOSTICS = 500;
export const MAX_DIAGNOSTICS_PER_FILE = 100;
export const MAX_SELECTED_TEXT_BYTES = 100_000; // 100 KB
export const MAX_COMMANDS = 2000;

/** Must match BRIDGE_PROTOCOL_VERSION in the bridge server's src/version.ts */
export const EXTENSION_PROTOCOL_VERSION = "1.1.0";
