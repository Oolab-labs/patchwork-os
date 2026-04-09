import type { TestRunResult } from "../automation.js";
import type { ProbeResults } from "../probe.js";
import type { ProgressFn } from "../transport.js";
import { cargoTestRunner } from "./testRunners/cargoTest.js";
import { goTestRunner } from "./testRunners/goTest.js";
import { pytestRunner } from "./testRunners/pytest.js";
import type { TestResult, TestRunner } from "./testRunners/types.js";
import { jestRunner, vitestRunner } from "./testRunners/vitestJest.js";
import { optionalBool, optionalString, success } from "./utils.js";

const MAX_CACHE_ENTRIES = 50;

const ALL_RUNNERS: TestRunner[] = [
  vitestRunner,
  jestRunner,
  pytestRunner,
  cargoTestRunner,
  goTestRunner,
];

interface RunnerCache {
  data: TestResult[];
  timestamp: number;
}

export function createRunTestsTool(
  workspace: string,
  probes?: ProbeResults,
  onTestRun?: (result: TestRunResult) => void,
) {
  const availableRunners = probes
    ? ALL_RUNNERS.filter((r) => r.detect(workspace, probes))
    : [];

  const caches = new Map<string, RunnerCache>();
  const runningPromises = new Map<string, Promise<TestResult[]>>();
  const runnerErrors = new Map<string, string>();
  // Tracks noCache eviction generation per key. When noCache bumps a key's
  // generation, any in-flight run for that key will see a mismatch and skip
  // the cache write, preventing stale results from overwriting fresh ones.
  const cacheGenerations = new Map<string, number>();

  async function runRunner(
    runner: TestRunner,
    filter?: string,
    signal?: AbortSignal,
  ): Promise<TestResult[]> {
    const cacheKey = `${runner.name}:${filter ?? ""}`;
    const now = Date.now();
    const cached = caches.get(cacheKey);
    if (cached && now - cached.timestamp < runner.cacheTtl) {
      return cached.data;
    }

    let running = runningPromises.get(cacheKey);
    if (!running) {
      const myGeneration = cacheGenerations.get(cacheKey) ?? 0;
      running = runner
        .run(workspace, filter, signal)
        .then((data) => {
          // Only write to cache if we are still the current generation.
          // noCache eviction bumps the generation so a stale in-flight run
          // does not overwrite the fresh run's results.
          if ((cacheGenerations.get(cacheKey) ?? 0) === myGeneration) {
            // Evict oldest entry if cache is full
            if (caches.size >= MAX_CACHE_ENTRIES) {
              const oldestKey = caches.keys().next().value;
              if (oldestKey) caches.delete(oldestKey);
            }
            caches.set(cacheKey, { data, timestamp: Date.now() });
            // Clear any previous error for this runner on success
            runnerErrors.delete(runner.name);
          }
          return data;
        })
        .catch((err: unknown) => {
          if (!(err instanceof Error) || err.name !== "AbortError") {
            if ((cacheGenerations.get(cacheKey) ?? 0) === myGeneration) {
              caches.set(cacheKey, { data: [], timestamp: Date.now() });
              runnerErrors.set(
                runner.name,
                err instanceof Error ? err.message : String(err),
              );
            }
          }
          return [] as TestResult[];
        })
        .finally(() => {
          runningPromises.delete(cacheKey);
        });
      runningPromises.set(cacheKey, running);
    }
    return running;
  }

  return {
    schema: {
      name: "runTests",
      description:
        "Run tests using auto-detected frameworks (Vitest, Jest, Pytest, Cargo test, Go test). Returns structured results with pass/fail status, failure messages, and file:line locations for correlation with code changes. Results are cached per runner (30s TTL) — use noCache: true after code changes to get fresh results.",
      annotations: {
        title: "Run Tests",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object" as const,
        properties: {
          filter: {
            type: "string",
            description:
              "Test name pattern or file path to filter which tests run",
          },
          runner: {
            type: "string",
            description:
              "Specific runner to use (e.g., 'vitest', 'jest', 'pytest', 'cargo-test', 'go-test'). Default: all detected",
          },
          noCache: {
            type: "boolean",
            description: "Skip cache and force a fresh run. Default: false",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          available: {
            type: "boolean",
            description: "Whether any test runners were detected",
          },
          runners: {
            type: "array",
            items: { type: "string" },
            description: "Names of runners that were executed",
          },
          summary: {
            type: "object",
            properties: {
              total: { type: "integer" },
              passed: { type: "integer" },
              failed: { type: "integer" },
              skipped: { type: "integer" },
              errored: { type: "integer" },
              durationMs: { type: "number" },
            },
            required: [
              "total",
              "passed",
              "failed",
              "skipped",
              "errored",
              "durationMs",
            ],
          },
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                status: {
                  type: "string",
                  enum: ["passed", "failed", "skipped", "errored"],
                },
                file: { type: "string" },
                line: { type: "integer" },
                message: { type: "string" },
                durationMs: { type: "number" },
              },
              required: ["name", "status"],
            },
          },
          failures: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                status: { type: "string" },
                file: { type: "string" },
                line: { type: "integer" },
                message: { type: "string" },
                durationMs: { type: "number" },
              },
              required: ["name", "status"],
            },
            description: "Subset of results where status is failed or errored",
          },
          error: {
            type: "string",
            description:
              "Set when a specific runner was requested but not found",
          },
        },
        required: ["available", "runners", "summary", "results", "failures"],
      },
    },

    async handler(
      args: Record<string, unknown>,
      signal?: AbortSignal,
      progress?: ProgressFn,
    ) {
      progress?.(0, 100);
      const filter = optionalString(args, "filter");
      const runnerName = optionalString(args, "runner");
      const noCache = optionalBool(args, "noCache") ?? false;

      if (availableRunners.length === 0) {
        return success({
          available: false,
          runners: [],
          summary: {
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            errored: 0,
            durationMs: 0,
          },
          results: [],
          failures: [],
        });
      }

      let runners = availableRunners;
      if (runnerName) {
        runners = availableRunners.filter((r) => r.name === runnerName);
        if (runners.length === 0) {
          return success({
            available: true,
            runners: availableRunners.map((r) => r.name),
            error: `Runner '${runnerName}' not found. Available: ${availableRunners.map((r) => r.name).join(", ")}`,
            summary: {
              total: 0,
              passed: 0,
              failed: 0,
              skipped: 0,
              errored: 0,
              durationMs: 0,
            },
            results: [],
            failures: [],
          });
        }
      }

      if (noCache) {
        for (const r of runners) {
          const key = `${r.name}:${filter ?? ""}`;
          caches.delete(key);
          // Evict in-flight run so a fresh subprocess is started.
          runningPromises.delete(key);
          // Bump generation so any still-running evicted promise will not
          // write its stale result to cache when it eventually resolves.
          cacheGenerations.set(key, (cacheGenerations.get(key) ?? 0) + 1);
        }
      }

      const startTime = Date.now();
      const allResults = await Promise.all(
        runners.map((r) => runRunner(r, filter, signal)),
      );
      const results = allResults.flat();
      const durationMs = Date.now() - startTime;

      const summary = {
        total: results.length,
        passed: results.filter((r) => r.status === "passed").length,
        failed: results.filter((r) => r.status === "failed").length,
        skipped: results.filter((r) => r.status === "skipped").length,
        errored: results.filter((r) => r.status === "errored").length,
        durationMs,
      };

      // Collect any runner errors from this execution
      const errors: Record<string, string> = {};
      for (const r of runners) {
        const err = runnerErrors.get(r.name);
        if (err) errors[r.name] = err;
      }

      const failures = results.filter(
        (r) => r.status === "failed" || r.status === "errored",
      );

      // Fire automation hook (best-effort — errors must not propagate to caller)
      if (onTestRun) {
        try {
          onTestRun({
            runners: runners.map((r) => r.name),
            summary,
            failures: failures.map((f) => ({
              name: f.name,
              file: f.file,
              message: f.message,
            })),
          });
        } catch {
          // ignore — automation hook failures must not affect tool output
        }
      }

      progress?.(100, 100);
      return success({
        available: true,
        runners: runners.map((r) => r.name),
        summary,
        results,
        failures,
        ...(Object.keys(errors).length > 0 && { runnerErrors: errors }),
      });
    },
  };
}
