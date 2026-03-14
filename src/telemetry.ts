/**
 * OpenTelemetry instrumentation for claude-ide-bridge.
 * Zero-overhead when OTEL_EXPORTER_OTLP_ENDPOINT is not set (uses no-op tracer).
 * When set, exports traces to the configured OTLP endpoint.
 *
 * GenAI semantic conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */
import { trace, type Tracer, type Span, SpanStatusCode } from '@opentelemetry/api';

let _initialized = false;

export function initTelemetry(): void {
  if (_initialized) return;
  _initialized = true;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return; // no-op mode

  // Dynamic import to avoid loading SDK when not needed
  Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
  ]).then(([{ NodeSDK }, { OTLPTraceExporter }]) => {
    const sdk = new NodeSDK({
      traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
      serviceName: process.env.OTEL_SERVICE_NAME ?? 'claude-ide-bridge',
    });
    sdk.start();
    process.on('SIGTERM', () => sdk.shutdown());
    process.on('SIGINT', () => sdk.shutdown());
  }).catch(() => {
    // OTEL init failure is non-fatal
  });
}

export function getTracer(): Tracer {
  return trace.getTracer('claude-ide-bridge');
}

/** Wrap an async function in an OTEL span. No-ops when tracing is disabled. */
export async function withSpan<T>(
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>
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
