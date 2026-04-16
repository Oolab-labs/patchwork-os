import { describe, expect, it, vi } from "vitest";
import {
  err,
  flatMapResult,
  legacyParseArgs,
  mapResult,
  ok,
  okL,
  okS,
  okSL,
  toCallToolResult,
  traverse,
} from "../result.js";

describe("ok constructors", () => {
  it("ok produces plain shape", () => {
    const r = ok(42);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.shape).toBe("plain");
      expect(r.value).toBe(42);
    }
  });

  it("okS produces structured shape", () => {
    const r = okS({ x: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.shape).toBe("structured");
      expect(r.value).toEqual({ x: 1 });
    }
  });

  it("okL produces large shape", () => {
    const r = okL("big");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.shape).toBe("large");
      expect(r.value).toBe("big");
    }
  });

  it("okSL produces structuredLarge shape", () => {
    const r = okSL({ items: [] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.shape).toBe("structuredLarge");
      expect(r.value).toEqual({ items: [] });
    }
  });
});

describe("err constructor", () => {
  it("produces ok:false with code and message", () => {
    const r = err("invalid_arg", "bad input");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("invalid_arg");
      expect(r.message).toBe("bad input");
    }
  });
});

describe("toCallToolResult", () => {
  it("plain shape → success (no structuredContent)", () => {
    const result = toCallToolResult(ok({ n: 1 }));
    expect(result.content[0].text).toBe(JSON.stringify({ n: 1 }));
    expect("structuredContent" in result).toBe(false);
    expect("isError" in result).toBe(false);
  });

  it("structured shape → successStructured (has structuredContent)", () => {
    const result = toCallToolResult(okS({ n: 2 }));
    expect(result.content[0].text).toBe(JSON.stringify({ n: 2 }));
    expect(
      (result as { structuredContent?: unknown }).structuredContent,
    ).toEqual({ n: 2 });
  });

  it("large shape → successLarge (has _meta)", () => {
    const result = toCallToolResult(okL("data"));
    const meta = (result.content[0] as { _meta?: Record<string, unknown> })
      ._meta;
    expect(meta?.["anthropic/maxResultSizeChars"]).toBeDefined();
    expect("structuredContent" in result).toBe(false);
  });

  it("structuredLarge shape → successStructuredLarge (has structuredContent + _meta)", () => {
    const result = toCallToolResult(okSL({ x: 3 }));
    const meta = (result.content[0] as { _meta?: Record<string, unknown> })
      ._meta;
    expect(meta?.["anthropic/maxResultSizeChars"]).toBeDefined();
    expect(
      (result as { structuredContent?: unknown }).structuredContent,
    ).toEqual({ x: 3 });
  });

  it("error case → isError:true", () => {
    const result = toCallToolResult(err("timeout", "timed out"));
    expect((result as { isError?: boolean }).isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text) as Record<
      string,
      unknown
    >;
    expect(parsed.error).toBe("timed out");
    expect(parsed.code).toBe("timeout");
  });
});

describe("mapResult", () => {
  it("transforms value on ok", () => {
    const r = mapResult(ok(2), (v) => v * 10);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(20);
  });

  it("passes through error unchanged", () => {
    const orig = err<number>("exec_failed", "oops");
    const r = mapResult(orig, (v) => v * 10);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("exec_failed");
      expect(r.message).toBe("oops");
    }
  });
});

describe("flatMapResult", () => {
  it("chains ok → ok", () => {
    const r = flatMapResult(ok(5), (v) => okS(v + 1));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(6);
      expect(r.shape).toBe("structured");
    }
  });

  it("passes outer error through without calling f", () => {
    let called = false;
    const r = flatMapResult(err<number>("unknown", "nope"), (v) => {
      called = true;
      return ok(v);
    });
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });

  it("propagates inner error", () => {
    const r = flatMapResult(ok(1), () => err("task_not_found", "missing"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("task_not_found");
  });
});

describe("legacyParseArgs", () => {
  it("returns ok when fn succeeds", () => {
    const r = legacyParseArgs(() => ({ x: 42 }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ x: 42 });
  });

  it("returns err(invalid_arg) when fn throws Error", () => {
    const r = legacyParseArgs(() => {
      throw new Error("bad value");
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("invalid_arg");
      expect(r.message).toBe("bad value");
    }
  });

  it("returns err(invalid_arg) when fn throws non-Error", () => {
    const r = legacyParseArgs(() => {
      throw "string error";
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("invalid_arg");
      expect(r.message).toBe("string error");
    }
  });

  it("calls logger.warn on failure", () => {
    const logger = { warn: vi.fn() };
    legacyParseArgs(() => {
      throw new Error("oops");
    }, logger);
    expect(logger.warn).toHaveBeenCalledWith("arg validation failure", {
      message: "oops",
    });
  });

  it("does not call logger when fn succeeds", () => {
    const logger = { warn: vi.fn() };
    legacyParseArgs(() => 1, logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("traverse", () => {
  it("maps all items successfully", async () => {
    const result = await traverse([1, 2, 3], async (n) => n * 2);
    expect(result).toEqual([2, 4, 6]);
  });

  it("throws when item fails and no onError", async () => {
    await expect(
      traverse([1, 2, 3], async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  it("calls onError for failed items when provided", async () => {
    const result = await traverse(
      [1, 2, 3],
      async (n) => {
        if (n === 2) throw new Error("boom");
        return n * 10;
      },
      (_a, _err, _i) => -1,
    );
    expect(result).toEqual([10, -1, 30]);
  });

  it("passes index to f and onError", async () => {
    const indices: number[] = [];
    const errIndices: number[] = [];
    await traverse(
      ["a", "b", "c"],
      async (_item, i) => {
        indices.push(i);
        if (i === 1) throw new Error("x");
        return i;
      },
      (_a, _err, i) => {
        errIndices.push(i);
        return -1;
      },
    );
    expect(indices).toEqual([0, 1, 2]);
    expect(errIndices).toEqual([1]);
  });

  it("returns empty array for empty input", async () => {
    const result = await traverse([], async (n: number) => n);
    expect(result).toEqual([]);
  });
});
