/**
 * OpenTelemetry instrumentation for claude-ide-bridge.
 * Zero-overhead when OTEL_EXPORTER_OTLP_ENDPOINT is not set (uses no-op tracer).
 * When set, exports traces to the configured OTLP endpoint.
 *
 * GenAI semantic conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */
import {
  type Span,
  SpanStatusCode,
  type Tracer,
  trace,
} from "@opentelemetry/api";

let _initialized = false;
/** Resolves once the SDK has been started (or immediately if no endpoint configured). */
let _initPromise: Promise<void> | null = null;

export function initTelemetry(): void {
  if (_initialized) return;
  _initialized = true;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    _initPromise = Promise.resolve();
    return; // no-op mode
  }

  // Dynamic import to avoid loading SDK when not needed
  _initPromise = Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
  ])
    .then(([{ NodeSDK }, { OTLPTraceExporter }]) => {
      const sdk = new NodeSDK({
        traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
        serviceName: process.env.OTEL_SERVICE_NAME ?? "claude-ide-bridge",
      });
      sdk.start();
      // Flush spans on process exit. We hook `beforeExit` / `exit` rather than
      // SIGTERM/SIGINT to avoid racing with the bridge.ts signal handlers that
      // also call process.exit(). Using `exit` (synchronous) is not ideal for async
      // flush, but `beforeExit` fires before the bridge's signal handler calls
      // process.exit(0), giving the SDK a chance to flush in-flight spans.
      // If OTEL_EXPORTER_OTLP_ENDPOINT is set, the bridge's own SIGTERM handler
      // should await sdk.shutdown() via the exported `shutdownTelemetry` function.
      let _sdk: typeof sdk | null = sdk;
      (globalThis as Record<string, unknown>).__otelSdk = sdk;
      process.once("beforeExit", () => {
        if (_sdk) {
          _sdk.shutdown().catch(() => {});
          _sdk = null;
        }
      });
    })
    .catch(() => {
      // OTEL init failure is non-fatal
    });
}

/**
 * Flush and shut down the OTEL SDK. Call this from the bridge shutdown path
 * (SIGTERM/SIGINT handler) before calling process.exit() so in-flight spans
 * are exported. No-ops if telemetry was not initialized.
 */
export async function shutdownTelemetry(): Promise<void> {
  // Wait for initTelemetry()'s dynamic import to finish before attempting shutdown.
  // Without this, if SIGTERM arrives before the import resolves, __otelSdk is
  // not yet set and we silently skip flushing in-flight spans.
  if (_initPromise) {
    await _initPromise.catch(() => {});
  }
  const sdk = (globalThis as Record<string, unknown>).__otelSdk as
    | { shutdown(): Promise<void> }
    | undefined;
  if (sdk) {
    (globalThis as Record<string, unknown>).__otelSdk = undefined;
    await sdk.shutdown().catch(() => {});
  }
}

export function getTracer(): Tracer {
  return trace.getTracer("claude-ide-bridge");
}

/** Wrap an async function in an OTEL span. No-ops when tracing is disabled. */
export async function withSpan<T>(
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, async (span) => {
    for (const [k, v] of Object.entries(attrs)) {
      span.setAttribute(k, v);
    }
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}
