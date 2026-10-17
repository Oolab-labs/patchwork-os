import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The reporter resolves its output path at import time, so each test imports a
// fresh copy after pointing VITEST_PROGRESS_FILE at its own directory.
let dir;
let out;
async function freshReporter() {
  vi.resetModules();
  const mod = await import("./vitest-progress-reporter.mjs");
  return new mod.default();
}
function events() {
  try {
    return readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
function fakeCase({ retryCount, flaky = retryCount > 0, state = "passed" }) {
  return {
    fullName: "suite > a case",
    module: { moduleId: join(process.cwd(), "src", "x.test.ts") },
    diagnostic: () => ({ retryCount, flaky }),
    result: () => ({ state }),
  };
}

describe("vitest progress reporter: retried tests", () => {
  let write;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "progress-reporter-"));
    out = join(dir, "p.jsonl");
    vi.stubEnv("VITEST_PROGRESS_FILE", out);
    vi.stubEnv("GITHUB_ACTIONS", "true");
    write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    write.mockRestore();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("records nothing for a case that passed first time", async () => {
    const r = await freshReporter();
    r.onTestCaseResult(fakeCase({ retryCount: 0 }));
    expect(events()).toEqual([]);
    expect(write).not.toHaveBeenCalled();
  });

  it("records a retried case with a repo-relative path and annotates it", async () => {
    const r = await freshReporter();
    r.onTestCaseResult(fakeCase({ retryCount: 2 }));
    const [e] = events();
    expect(e).toMatchObject({
      ev: "retried",
      file: "src/x.test.ts",
      name: "suite > a case",
      retries: 2,
      flaky: true,
      state: "passed",
    });
    const text = write.mock.calls.map((c) => String(c[0])).join("");
    // Must start a fresh line, or GitHub ignores the command.
    expect(text).toMatch(
      /\n::warning title=Test needed a retry::suite > a case \(src\/x\.test\.ts\) took 2 retries/,
    );
  });

  it("records a case that failed every attempt as well", async () => {
    const r = await freshReporter();
    r.onTestCaseResult(
      fakeCase({ retryCount: 2, flaky: false, state: "failed" }),
    );
    expect(events()[0]).toMatchObject({
      retries: 2,
      flaky: false,
      state: "failed",
    });
  });

  it("does not annotate outside GitHub Actions", async () => {
    vi.stubEnv("GITHUB_ACTIONS", "");
    const r = await freshReporter();
    r.onTestCaseResult(fakeCase({ retryCount: 1 }));
    expect(events()).toHaveLength(1);
    expect(write).not.toHaveBeenCalled();
  });

  it("never throws on a malformed case", async () => {
    const r = await freshReporter();
    expect(() =>
      r.onTestCaseResult({
        diagnostic: () => {
          throw new Error("x");
        },
      }),
    ).not.toThrow();
    expect(() => r.onTestCaseResult(undefined)).not.toThrow();
  });
});
