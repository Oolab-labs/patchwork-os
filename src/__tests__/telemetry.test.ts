import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for src/telemetry.ts.
 *
 * telemetry.ts is env-gated and dynamically imports the real OpenTelemetry SDK,
 * holding module-level singleton state (`_initialized`, `_initPromise`, and a
 * `globalThis.__otelSdk` handle). To get a clean slate per test we `vi.resetModules()`
 * and dynamically re-import the module, and we clear the shared `__otelSdk` handle.
 *
 * We exercise the real SDK rather than mocking it — the behaviour under test
 * (which span processor the provider is built with, and that shutdown flushes it)
 * only exists in the genuine SDK objects. We stub the OTLP exporter's network
 * `export` so nothing leaves the process.
 *
 * Limitation: we cannot assert the asynchronous-batch *timing* of
 * BatchSpanProcessor in a unit test without a long wait or fake timers fighting
 * the SDK's internal interval. We instead assert the structural contract that
 * matters for the regression: the provider is constructed with a
 * `BatchSpanProcessor` (not `SimpleSpanProcessor`), and the shutdown path drains
 * it. Those are the two properties the production swap depends on.
 */

const ENDPOINT_VAR = "OTEL_EXPORTER_OTLP_ENDPOINT";

function clearOtelHandle() {
  (globalThis as Record<string, unknown>).__otelSdk = undefined;
}

async function importTelemetryFresh() {
  vi.resetModules();
  return import("../telemetry.js");
}

let savedEndpoint: string | undefined;
let savedServiceName: string | undefined;

beforeEach(() => {
  savedEndpoint = process.env[ENDPOINT_VAR];
  savedServiceName = process.env.OTEL_SERVICE_NAME;
  delete process.env[ENDPOINT_VAR];
  delete process.env.OTEL_SERVICE_NAME;
  clearOtelHandle();
});

afterEach(() => {
  if (savedEndpoint === undefined) delete process.env[ENDPOINT_VAR];
  else process.env[ENDPOINT_VAR] = savedEndpoint;
  if (savedServiceName === undefined) delete process.env.OTEL_SERVICE_NAME;
  else process.env.OTEL_SERVICE_NAME = savedServiceName;
  clearOtelHandle();
  vi.restoreAllMocks();
});

describe("initTelemetry — OTEL endpoint unset (no-op mode)", () => {
  it("does not construct an SDK / leaves the global handle unset", async () => {
    const tel = await importTelemetryFresh();
    tel.initTelemetry();
    // No SDK should be registered when the endpoint is not configured.
    expect((globalThis as Record<string, unknown>).__otelSdk).toBeUndefined();
  });

  it("shutdownTelemetry is a complete no-op (resolves, no throw)", async () => {
    const tel = await importTelemetryFresh();
    tel.initTelemetry();
    await expect(tel.shutdownTelemetry()).resolves.toBeUndefined();
    expect((globalThis as Record<string, unknown>).__otelSdk).toBeUndefined();
  });

  it("getTracer still returns a tracer (no-op tracer) without an endpoint", async () => {
    const tel = await importTelemetryFresh();
    tel.initTelemetry();
    const tracer = tel.getTracer();
    expect(tracer).toBeDefined();
    expect(typeof tracer.startActiveSpan).toBe("function");
  });
});

describe("initTelemetry — OTEL endpoint set", () => {
  it("constructs the provider with a BatchSpanProcessor (not SimpleSpanProcessor)", async () => {
    process.env[ENDPOINT_VAR] = "http://127.0.0.1:4318";

    // Reset modules FIRST so the spy below lands on the same fresh SDK module
    // instance that initTelemetry()'s dynamic import will resolve. Spying before
    // resetModules would patch a stale module graph and never fire.
    const tel = await importTelemetryFresh();

    // Prevent the exporter from making real network calls.
    const { OTLPTraceExporter } = await import(
      "@opentelemetry/exporter-trace-otlp-http"
    );
    vi.spyOn(OTLPTraceExporter.prototype, "export").mockImplementation(
      (_spans, resultCallback) => {
        resultCallback({ code: 0 });
      },
    );

    tel.initTelemetry();
    // Wait for the dynamic SDK import inside initTelemetry to resolve. The module
    // exposes that work via shutdownTelemetry()'s await on _initPromise; we instead
    // poll the global handle which is set at the end of the same .then().
    await vi.waitFor(() => {
      expect((globalThis as Record<string, unknown>).__otelSdk).toBeDefined();
    });

    const provider = (globalThis as Record<string, unknown>).__otelSdk as {
      _config: { spanProcessors: Array<{ constructor: { name: string } }> };
    };
    const processors = provider._config.spanProcessors;
    expect(processors).toHaveLength(1);
    const processor0 = processors[0];
    expect(processor0).toBeDefined();
    expect(processor0?.constructor.name).toBe("BatchSpanProcessor");
    expect(processor0?.constructor.name).not.toBe("SimpleSpanProcessor");

    // Drain so the test leaves no dangling batch interval.
    await tel.shutdownTelemetry();
  });

  it("shutdownTelemetry drains the BatchSpanProcessor (flush on exit) and clears the handle", async () => {
    process.env[ENDPOINT_VAR] = "http://127.0.0.1:4318";

    // Reset modules FIRST (see note in the test above) so the export stub below
    // lands on the same fresh exporter module instance initTelemetry() will use.
    const tel = await importTelemetryFresh();

    // Stub the OTLP exporter's network call so nothing leaves the process.
    const { OTLPTraceExporter } = await import(
      "@opentelemetry/exporter-trace-otlp-http"
    );
    vi.spyOn(OTLPTraceExporter.prototype, "export").mockImplementation(
      (_spans, resultCallback) => {
        resultCallback({ code: 0 });
      },
    );

    tel.initTelemetry();
    await vi.waitFor(() => {
      expect((globalThis as Record<string, unknown>).__otelSdk).toBeDefined();
    });

    // Reach into the actual constructed provider and spy on the real
    // BatchSpanProcessor instance's shutdown(). This is module-identity
    // independent: BatchSpanProcessor.shutdown() drains (flushes) the in-memory
    // span queue before resolving, so asserting it is invoked proves the
    // flush-on-exit path that short-lived CLI invocations depend on.
    const provider = (globalThis as Record<string, unknown>).__otelSdk as {
      _config: { spanProcessors: Array<{ shutdown: () => Promise<void> }> };
    };
    const processor = provider._config.spanProcessors[0];
    if (!processor) throw new Error("expected a span processor");
    const procShutdownSpy = vi.spyOn(processor, "shutdown");

    await tel.shutdownTelemetry();

    // provider.shutdown() drained the batch processor (flush on exit)...
    expect(procShutdownSpy).toHaveBeenCalledTimes(1);
    // ...and cleared the handle so a second shutdown is a complete no-op.
    expect((globalThis as Record<string, unknown>).__otelSdk).toBeUndefined();
    await expect(tel.shutdownTelemetry()).resolves.toBeUndefined();
    // Second shutdown must NOT re-invoke the (already-drained) processor.
    expect(procShutdownSpy).toHaveBeenCalledTimes(1);
  });
});
