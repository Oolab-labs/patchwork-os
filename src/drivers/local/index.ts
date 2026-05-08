import { OpenAIApiDriver } from "../openai/index.js";

/**
 * Reject any LOCAL_ENDPOINT that doesn't resolve to loopback or RFC1918
 * private space. The local driver streams the user prompt + context-file
 * paths to whatever URL is set; if a malicious recipe (or a user pasting
 * a phishy "free local LLM" link) sets `LOCAL_ENDPOINT=https://attacker/v1`,
 * everything the local driver receives gets exfiltrated.
 *
 * Rule: hostname must be one of
 *   - localhost / 127.0.0.1 / ::1
 *   - RFC1918 private space (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
 *   - link-local (169.254.0.0/16, fe80::/10)
 *   - .local mDNS / .lan / .home / .internal suffixes
 *
 * To opt out (e.g. authorized remote inference cluster), the operator can
 * set LOCAL_ENDPOINT_ALLOW_REMOTE=1 — explicit override, audited via env.
 */
export function isLoopbackOrPrivateEndpoint(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  // Strip IPv6 brackets if any
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return true;
  }
  // mDNS / common LAN suffixes
  if (
    host.endsWith(".local") ||
    host.endsWith(".lan") ||
    host.endsWith(".home") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  // IPv4 RFC1918 + link-local + 127/8
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  // IPv6 link-local fe80::/10 and unique-local fc00::/7
  if (
    host.startsWith("fe8") ||
    host.startsWith("fe9") ||
    host.startsWith("fea") ||
    host.startsWith("feb")
  ) {
    return true;
  }
  if (host.startsWith("fc") || host.startsWith("fd")) {
    return true;
  }
  return false;
}

/**
 * Local LLM driver — Ollama, LM Studio, vLLM, llama.cpp server, and most
 * other self-hosted runtimes expose an OpenAI-compatible chat-completions
 * endpoint at /v1/chat/completions. Same trick as Grok / Gemini API:
 * subclass OpenAIApiDriver with a different baseURL + default model.
 *
 * Auth: most local runtimes don't validate the API key, but the OpenAI SDK
 * requires *something* in the apiKey field — we send a constant placeholder.
 *
 * Configuration: LOCAL_ENDPOINT and LOCAL_MODEL environment variables.
 * The bridge auto-injects `patchwork.localEndpoint` / `patchwork.localModel`
 * into these env vars at startup (see config.ts), so saving via the
 * dashboard's Local LLM card flows straight through to the driver.
 *
 * Examples:
 *   Ollama     → http://localhost:11434/v1
 *   LM Studio  → http://localhost:1234/v1
 *   vLLM       → http://localhost:8000/v1
 *   llama.cpp  → http://localhost:8080/v1
 */
export class LocalApiDriver extends OpenAIApiDriver {
  override readonly name = "local";

  constructor(log: (msg: string) => void) {
    const baseURL = process.env.LOCAL_ENDPOINT;
    if (!baseURL) {
      throw new Error(
        "LocalApiDriver requires LOCAL_ENDPOINT environment variable (e.g. http://localhost:11434/v1)",
      );
    }
    if (
      process.env.LOCAL_ENDPOINT_ALLOW_REMOTE !== "1" &&
      !isLoopbackOrPrivateEndpoint(baseURL)
    ) {
      throw new Error(
        `LocalApiDriver: LOCAL_ENDPOINT="${baseURL}" is not loopback or private. ` +
          `The local driver streams prompts + context to this URL — a public host ` +
          `would exfiltrate them. Set LOCAL_ENDPOINT_ALLOW_REMOTE=1 to override ` +
          `(only for audited internal inference clusters).`,
      );
    }
    super(log, {
      baseURL,
      // Per-install default — caller can still override via input.model.
      defaultModel: process.env.LOCAL_MODEL ?? "llama3.2",
    });
  }

  protected override apiKey(): string | undefined {
    // Most local runtimes ignore the key but the OpenAI SDK requires a
    // non-empty value. "ollama" is the conventional placeholder.
    return process.env.LOCAL_API_KEY ?? "ollama";
  }
}
