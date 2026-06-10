/**
 * file.* byte-count + when-condition regressions (audit-2, audit-3, audit-4).
 *
 * audit-2 / audit-3: file.write / file.append reported `content.length`
 *   (UTF-16 code units) as bytesWritten / bytesAppended. For multibyte
 *   Unicode (emoji, CJK) that undercounts the actual bytes written to disk.
 *   The fix uses Buffer.byteLength(content, "utf8").
 *
 * audit-4: the in-tool `when` fallback evaluator hard-coded the left-hand
 *   numeric value to 0, so every `var > N` (N > 0) was permanently false and
 *   every `var <= N` permanently true regardless of the real value. The fix
 *   resolves the variable from the run context.
 *
 * These tests drive the registered tools directly with a tmp workspace as the
 * jail root and stub write/append deps so no real disk write is needed for the
 * append path (file.write does write through deps.writeFile, also a stub).
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../file.js";
import { getTool } from "../../toolRegistry.js";
import type { RunContext, StepDeps } from "../../yamlRunner.js";

const workspace = mkdtempSync(path.join(os.tmpdir(), "file-bytecount-"));

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const writeFile = vi.fn();
const appendFile = vi.fn();

function makeCtx(
  params: Record<string, unknown>,
  step: Record<string, unknown> = {},
  ctx: RunContext = {} as RunContext,
) {
  return {
    params,
    step,
    ctx,
    deps: {
      workdir: workspace,
      writeFile,
      appendFile,
    } as unknown as StepDeps,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("file.write bytesWritten (audit-2)", () => {
  it("reports UTF-8 byte length, not UTF-16 char count, for a 4-byte emoji", async () => {
    const tool = getTool("file.write");
    // "😀" is one UTF-16 surrogate pair (length 2) but 4 UTF-8 bytes.
    const content = "😀";
    const out = await tool?.execute(makeCtx({ path: "out.txt", content }));
    const parsed = JSON.parse(out ?? "{}");
    expect(content.length).toBe(2); // sanity: UTF-16 units
    expect(parsed.bytesWritten).toBe(4); // actual UTF-8 bytes
    expect(parsed.bytesWritten).toBe(Buffer.byteLength(content, "utf8"));
  });

  it("matches char count for pure ASCII", async () => {
    const tool = getTool("file.write");
    const out = await tool?.execute(
      makeCtx({ path: "ascii.txt", content: "hello" }),
    );
    expect(JSON.parse(out ?? "{}").bytesWritten).toBe(5);
  });
});

describe("file.append bytesAppended (audit-3)", () => {
  it("reports UTF-8 byte length for multibyte CJK content", async () => {
    const tool = getTool("file.append");
    // Each CJK char is 1 UTF-16 unit but 3 UTF-8 bytes.
    const content = "日本語"; // length 3, 9 bytes
    const out = await tool?.execute(makeCtx({ path: "cjk.txt", content }));
    const parsed = JSON.parse(out ?? "{}");
    expect(content.length).toBe(3);
    expect(parsed.bytesAppended).toBe(9);
    expect(parsed.bytesAppended).toBe(Buffer.byteLength(content, "utf8"));
  });
});

describe("file.append when-condition fallback (audit-4)", () => {
  it("evaluates `count > 0` against the run context, not a hard-coded 0", async () => {
    const tool = getTool("file.append");
    // count = 5 in context → "count > 0" is true → append runs.
    const out = await tool?.execute(
      makeCtx({ path: "guarded.txt", content: "x" }, { when: "count > 0" }, {
        count: "5",
      } as unknown as RunContext),
    );
    expect(appendFile).toHaveBeenCalledTimes(1);
    expect(out).not.toBeNull();
  });

  it("skips the append when the context value fails the condition", async () => {
    const tool = getTool("file.append");
    // count = 0 in context → "count > 0" is false → append skipped (returns null).
    const out = await tool?.execute(
      makeCtx({ path: "guarded.txt", content: "x" }, { when: "count > 0" }, {
        count: "0",
      } as unknown as RunContext),
    );
    expect(appendFile).not.toHaveBeenCalled();
    expect(out).toBeNull();
  });
});
