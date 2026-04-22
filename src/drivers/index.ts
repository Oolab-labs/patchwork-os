import { ApiDriver } from "./claude/api.js";
import { SubprocessDriver } from "./claude/subprocess.js";
import { GeminiSubprocessDriver } from "./gemini/index.js";
import { GrokApiDriver } from "./grok/index.js";
import { OpenAIApiDriver } from "./openai/index.js";
import type { ProviderDriver } from "./types.js";

export type DriverMode =
  | "subprocess"
  | "api"
  | "openai"
  | "grok"
  | "gemini"
  | "none";

export interface DriverFactoryOpts {
  binary: string;
  antBinary: string;
  /** Returns bridge HTTP MCP endpoint + auth token at run time (port may not be known at construction). */
  bridgeMcp?: () => { url: string; authToken: string } | undefined;
}

/**
 * Create the appropriate driver from a mode string.
 * Returns null for "none" (orchestration disabled).
 */
export function createDriver(
  mode: DriverMode,
  opts: DriverFactoryOpts,
  log: (msg: string) => void,
): ProviderDriver | null {
  if (mode === "none") return null;
  if (mode === "subprocess")
    return new SubprocessDriver(opts.binary, opts.antBinary, log);
  if (mode === "api") return new ApiDriver(log);
  if (mode === "openai") return new OpenAIApiDriver(log);
  if (mode === "grok") return new GrokApiDriver(log);
  if (mode === "gemini")
    return new GeminiSubprocessDriver(
      opts.binary === "claude" ? "gemini" : opts.binary,
      log,
      opts.bridgeMcp,
    );
  throw new Error(`Unknown driver mode: ${mode}`);
}

export { ApiDriver } from "./claude/api.js";
export { SubprocessDriver } from "./claude/subprocess.js";
export { GeminiSubprocessDriver } from "./gemini/index.js";
export { GrokApiDriver } from "./grok/index.js";
export { OpenAIApiDriver } from "./openai/index.js";
export type {
  ProviderDriver,
  ProviderTaskInput,
  ProviderTaskOutcome,
  ProviderTaskResult,
} from "./types.js";
export { toProviderTaskOutcome } from "./types.js";
