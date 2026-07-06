/**
 * InterpreterContext — backend interface + concrete implementations for the
 * AutomationProgram interpreter.
 */
import * as dns from "node:dns/promises";
import type { ClaudeOrchestrator } from "../claudeOrchestrator.js";
import { isLoopbackHost, isPrivateNonLoopbackHost } from "../ssrfGuard.js";
import type { AutomationState } from "./automationState.js";

// ── Backend interface ─────────────────────────────────────────────────────────

export interface BackendEnqueueOpts {
  prompt: string;
  triggerSource: string;
  sessionId: string;
  isAutomationTask: true;
  model?: string;
  effort?: "low" | "medium" | "high" | "max";
  systemPrompt?: string;
}

/**
 * Options for an outbound webhook fired by an automation hook.
 *
 * `body` is the JSON-serializable payload. Backends serialize and set
 * Content-Type if not already in `headers`. SSRF guarding is the backend's
 * responsibility (production: loopback-only by default; tests: collect).
 */
export interface BackendWebhookOpts {
  url: string;
  method: "POST" | "PUT" | "PATCH";
  headers: Readonly<Record<string, string>>;
  body: Readonly<Record<string, unknown>>;
  /** Hook key for diagnostic logging (e.g. "precompact"). */
  hookKey: string;
}

/**
 * Result of a webhook call. Always resolves — never throws — so a failed
 * webhook does not block the rest of the interpreter run.
 */
export interface BackendWebhookResult {
  ok: boolean;
  /** HTTP status code on a completed request; absent on network error / timeout. */
  status?: number;
  /** Reason on failure — surfaced in the interpreter error list and logs. */
  error?: string;
}

export interface BackendFireRecipeOpts {
  recipeName: string;
  /** Sanitised event data forwarded as seedContext into the recipe runner. */
  eventData: Readonly<Record<string, string>>;
  triggerSource: string;
}

/**
 * The complete set of side-effecting operations the automation interpreter
 * (`src/fp/automationInterpreter.ts`) needs to carry out a policy. Every
 * operation that touches the outside world — spawning tasks, firing
 * recipes, scheduling timers, logging, calling out over HTTP — must be a
 * method here, and `automationInterpreter.ts` must call it only through
 * this interface, never directly against VS Code APIs, Node timers, or
 * `fetch`.
 *
 * This is the seam that keeps the interpreter pure and deterministic: swap
 * in `VsCodeBackend` for production and `TestBackend` for tests, and the
 * exact same interpreter code runs against both. Tests assert on what
 * `TestBackend` recorded instead of mocking VS Code or the network.
 */
export interface Backend {
  /** Enqueue a task and return the task ID. */
  enqueueTask(opts: BackendEnqueueOpts): Promise<string>;
  /**
   * Run a named recipe through the recipe runner (not a raw claude -p subprocess).
   * Returns the task ID. Throws on failure so callers can record an error.
   */
  fireRecipe(opts: BackendFireRecipeOpts): Promise<string>;
  /** Schedule a retry after delayMs; returns a cancel function. */
  scheduleRetry(key: string, delayMs: number, fn: () => void): () => void;
  /** Emit an informational notification (fire-and-forget). */
  notify(msg: string): void;
  /**
   * Fire an outbound webhook. Always resolves — never rejects — so failures
   * never block other hooks. Production impl applies a 10s timeout and SSRF
   * guard. Test impl pushes to `webhookCalls`.
   */
  postWebhook(opts: BackendWebhookOpts): Promise<BackendWebhookResult>;
}

// ── Interpreter context ───────────────────────────────────────────────────────

export interface InterpreterContext {
  readonly state: AutomationState;
  readonly now: number;
  /** The event type that triggered this interpreter run (e.g. "onFileSave"). */
  readonly eventType: string;
  readonly eventData: Readonly<Record<string, string>>;
  readonly backend: Backend;
  readonly log: (msg: string) => void;
  /**
   * Optional accessor for the live AutomationState at retry-fire time. If
   * present, WithRetry uses this instead of the snapshot taken when the retry
   * was scheduled — preventing retries from re-firing hooks that have since
   * entered cooldown / dedup. AutomationHooks supplies a function that returns
   * `this._automationState`; tests may omit.
   */
  readonly getLiveState?: () => AutomationState;
  /**
   * Optional atomic-retry executor. Receives a function that, given the
   * truly-current `AutomationState` at lock-acquisition time, returns the
   * post-retry state. AutomationHooks runs this through `_enqueueMutation`
   * so the read-run-write happens atomically with respect to other
   * `_runInterpreter` calls (the same chain that prevents two concurrent
   * events from clobbering each other's writes).
   *
   * Replaces the older `mergeRetryState` setter API, which let a retry
   * publish stale absolute state and clobber writes from concurrent runs
   * that landed between scheduling and merge. Now the retry's interpret()
   * is itself executed inside the lock against fresh live state.
   *
   * Tests may omit (TestBackend doesn't fire retries by default).
   */
  readonly runRetryUnderLock?: (
    work: (live: AutomationState) => Promise<AutomationState>,
  ) => void;
}

// ── Interpreter result ────────────────────────────────────────────────────────

export interface InterpreterResult {
  readonly taskIds: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<{ reason: string; hook: string }>;
  readonly errors: ReadonlyArray<{ message: string; hook: string }>;
  readonly updatedState: AutomationState;
}

// ── VsCodeBackend ─────────────────────────────────────────────────────────────

/**
 * SSRF guard for automation webhooks.
 *
 * Default policy (`allowPrivate=false`):
 *   - Loopback (127.0.0.0/8, ::1, localhost, *.localhost) → ALLOWED.
 *     Automation hooks fire INTO the same machine on the common path;
 *     the bridge itself listens on 127.0.0.1, and recipe-6 webhooks
 *     target `http://127.0.0.1:${BRIDGE_PORT}/...`.
 *   - Other RFC 1918 / link-local / ULA / CGNAT / 0.0.0.0/8 → BLOCKED.
 *   - Public hosts → ALLOWED.
 *
 * Opt-in (`allowPrivate=true`) drops the private-range check entirely.
 *
 * This is a deliberate divergence from `sendHttpRequest` which blocks ALL
 * private addresses by default (loopback included). The reasoning: a
 * MCP-tool-driven HTTP request is potentially attacker-controlled (a
 * compromised LLM session could craft URLs); an automation webhook URL
 * comes from a trusted policy file that the operator wrote. Loopback is
 * the common case there, not the exceptional one.
 */
const WEBHOOK_TIMEOUT_MS = 10_000;

/** Production `Backend`: routes side effects to the real orchestrator, logger, and network. */
export class VsCodeBackend implements Backend {
  constructor(
    private readonly orchestrator: ClaudeOrchestrator,
    private readonly logger?: { info: (msg: string) => void },
    private readonly allowPrivateWebhooks: boolean = false,
    private readonly recipeFireFn?: (
      opts: BackendFireRecipeOpts,
    ) => Promise<string>,
  ) {}

  async enqueueTask(opts: BackendEnqueueOpts): Promise<string> {
    const taskId = this.orchestrator.enqueue({
      prompt: opts.prompt,
      sessionId: opts.sessionId,
      isAutomationTask: opts.isAutomationTask,
      triggerSource: opts.triggerSource,
      model: opts.model,
      effort: opts.effort,
      systemPrompt: opts.systemPrompt,
    });
    return taskId;
  }

  async fireRecipe(opts: BackendFireRecipeOpts): Promise<string> {
    if (!this.recipeFireFn) {
      throw new Error(
        `recipe invocation unavailable: no recipeFireFn provided (recipeName="${opts.recipeName}")`,
      );
    }
    return this.recipeFireFn(opts);
  }

  scheduleRetry(key: string, delayMs: number, fn: () => void): () => void {
    const handle = setTimeout(() => {
      this.logger?.info(`[automation] retrying ${key}`);
      fn();
    }, delayMs);
    return () => clearTimeout(handle);
  }

  notify(msg: string): void {
    this.logger?.info(msg);
  }

  async postWebhook(opts: BackendWebhookOpts): Promise<BackendWebhookResult> {
    let parsed: URL;
    try {
      parsed = new URL(opts.url);
    } catch (e) {
      const error = `invalid url: ${e instanceof Error ? e.message : String(e)}`;
      this.logger?.info(
        `[automation-webhook] ${opts.hookKey} blocked: ${error}`,
      );
      return { ok: false, error };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      const error = `unsupported protocol "${parsed.protocol}"`;
      this.logger?.info(
        `[automation-webhook] ${opts.hookKey} blocked: ${error}`,
      );
      return { ok: false, error };
    }
    if (
      !this.allowPrivateWebhooks &&
      isPrivateNonLoopbackHost(parsed.hostname)
    ) {
      const error = `private/non-loopback host "${parsed.hostname}" blocked (use --automation-allow-private-webhooks to enable)`;
      this.logger?.info(
        `[automation-webhook] ${opts.hookKey} blocked: ${error}`,
      );
      return { ok: false, error };
    }

    // LOW #25 — DNS pre-resolution SSRF guard.
    // Lexical hostname checks pass for public-looking names that resolve to
    // private IPs (e.g. DNS rebinding / split-horizon). Re-check after lookup.
    // Loopback is intentionally allowed (sidecar pattern), so we only block
    // private non-loopback resolved addresses. Skip for loopback hostnames
    // (already checked above) and when allowPrivateWebhooks is true.
    //
    // M15 — IP pinning to close the TOCTOU window.
    // After the check passes, we replace the hostname in the fetch URL with
    // the resolved IP so the subsequent fetch() cannot be redirected to a
    // different address via a second DNS resolution (DNS rebinding). The Host
    // header is set to the original hostname so the server still receives the
    // correct SNI/vhost value.
    let fetchUrl = opts.url;
    if (!this.allowPrivateWebhooks && !isLoopbackHost(parsed.hostname)) {
      try {
        const { address, family } = await dns.lookup(parsed.hostname);
        if (isPrivateNonLoopbackHost(address)) {
          const error = `private IP after DNS resolution: ${parsed.hostname} → ${address} (use --automation-allow-private-webhooks to enable)`;
          this.logger?.info(
            `[automation-webhook] ${opts.hookKey} blocked: ${error}`,
          );
          return { ok: false, error };
        }
        // Pin the resolved IP: replace hostname with IP in the URL.
        const pinnedHost = family === 6 ? `[${address}]` : address;
        fetchUrl = opts.url.replace(parsed.hostname, pinnedHost);
      } catch {
        // DNS failure is treated as non-blocking — let the subsequent fetch
        // surface the real network error. This mirrors the policy in
        // validateSafeUrl (ssrfGuard.ts) for non-install fetch paths.
      }
    }

    const headers: Record<string, string> = { ...opts.headers };
    const hasContentType = Object.keys(headers).some(
      (k) => k.toLowerCase() === "content-type",
    );
    if (!hasContentType) headers["Content-Type"] = "application/json";
    // If we pinned an IP, set the Host header so the server receives the
    // original hostname (required for virtual-host routing and TLS SNI).
    if (fetchUrl !== opts.url) {
      headers.Host = parsed.hostname;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const res = await fetch(fetchUrl, {
        method: opts.method,
        headers,
        body: JSON.stringify(opts.body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const error = `non-2xx response: ${res.status}`;
        this.logger?.info(
          `[automation-webhook] ${opts.hookKey} ${opts.method} ${opts.url} → ${res.status}`,
        );
        return { ok: false, status: res.status, error };
      }
      this.logger?.info(
        `[automation-webhook] ${opts.hookKey} ${opts.method} ${opts.url} → ${res.status}`,
      );
      return { ok: true, status: res.status };
    } catch (e) {
      clearTimeout(timer);
      const error =
        e instanceof Error
          ? e.name === "AbortError"
            ? `timeout after ${WEBHOOK_TIMEOUT_MS}ms`
            : e.message
          : String(e);
      this.logger?.info(
        `[automation-webhook] ${opts.hookKey} ${opts.method} ${opts.url} failed: ${error}`,
      );
      return { ok: false, error };
    }
  }
}

// ── TestBackend ───────────────────────────────────────────────────────────────

export interface TestBackendCollector {
  enqueuedTasks: BackendEnqueueOpts[];
  firedRecipes: BackendFireRecipeOpts[];
  scheduledRetries: Array<{ key: string; delayMs: number }>;
  notifications: string[];
  webhookCalls: BackendWebhookOpts[];
}

/**
 * Test `Backend`: a collector, not a mock. Every call is pushed onto
 * `collector` (enqueuedTasks, firedRecipes, scheduledRetries, notifications,
 * webhookCalls) instead of touching the real world, so tests assert against
 * recorded calls rather than mocking VS Code / orchestrator / network APIs.
 */
export class TestBackend implements Backend {
  readonly collector: TestBackendCollector = {
    enqueuedTasks: [],
    firedRecipes: [],
    scheduledRetries: [],
    notifications: [],
    webhookCalls: [],
  };

  /**
   * Optional override for the webhook result a test wants to simulate.
   * When unset, postWebhook returns `{ ok: true, status: 200 }`.
   */
  webhookResponse: BackendWebhookResult = { ok: true, status: 200 };

  async enqueueTask(opts: BackendEnqueueOpts): Promise<string> {
    this.collector.enqueuedTasks.push(opts);
    return `task-${this.collector.enqueuedTasks.length}`;
  }

  async fireRecipe(opts: BackendFireRecipeOpts): Promise<string> {
    this.collector.firedRecipes.push(opts);
    return `recipe-task-${this.collector.firedRecipes.length}`;
  }

  scheduleRetry(key: string, delayMs: number, _fn: () => void): () => void {
    this.collector.scheduledRetries.push({ key, delayMs });
    // Do not actually schedule in test environment
    return () => {};
  }

  notify(msg: string): void {
    this.collector.notifications.push(msg);
  }

  async postWebhook(opts: BackendWebhookOpts): Promise<BackendWebhookResult> {
    this.collector.webhookCalls.push(opts);
    return this.webhookResponse;
  }

  /**
   * Clear the collector between tests so assertions in one test can't leak
   * into the next. Call in `beforeEach`/`afterEach` instead of constructing
   * a fresh `TestBackend` each time.
   */
  reset(): void {
    this.collector.enqueuedTasks = [];
    this.collector.firedRecipes = [];
    this.collector.scheduledRetries = [];
    this.collector.notifications = [];
    this.collector.webhookCalls = [];
    this.webhookResponse = { ok: true, status: 200 };
  }
}
