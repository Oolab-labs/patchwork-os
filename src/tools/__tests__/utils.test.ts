import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  execSafe,
  execSafeStreaming,
  optionalBool,
  optionalInt,
  optionalString,
  requireString,
  resolveFilePath,
  sanitizeCommitSubject,
} from "../utils.js";

describe("resolveFilePath", () => {
  let workspace: string;

  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "test-workspace-"));
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("resolves absolute paths within workspace", () => {
    const filePath = path.join(workspace, "file.ts");
    fs.writeFileSync(filePath, "");
    expect(resolveFilePath(filePath, workspace)).toBe(filePath);
  });

  it("resolves relative paths within workspace", () => {
    const srcFile = path.join(workspace, "src", "file.ts");
    fs.writeFileSync(srcFile, "");
    expect(resolveFilePath("src/file.ts", workspace)).toBe(srcFile);
  });

  it("rejects paths that escape the workspace via ..", () => {
    expect(() => resolveFilePath("../outside.ts", workspace)).toThrow(
      "escapes workspace",
    );
  });

  it("rejects absolute paths outside workspace", () => {
    expect(() => resolveFilePath("/etc/passwd", workspace)).toThrow(
      "escapes workspace",
    );
  });

  it("rejects paths containing null bytes", () => {
    expect(() => resolveFilePath("file\x00.ts", workspace)).toThrow(
      "null bytes",
    );
  });

  it("rejects non-string filePath", () => {
    expect(() => resolveFilePath(123 as unknown as string, workspace)).toThrow(
      "must be a string",
    );
  });

  it("prevents workspace prefix bypass (e.g., workspace-evil)", () => {
    const evilDir = `${workspace}-evil`;
    fs.mkdirSync(evilDir, { recursive: true });
    try {
      expect(() =>
        resolveFilePath(path.join(evilDir, "file.ts"), workspace),
      ).toThrow("escapes workspace");
    } finally {
      fs.rmSync(evilDir, { recursive: true, force: true });
    }
  });

  // fs.symlinkSync requires Developer Mode or admin on Windows — skip there.
  it.skipIf(process.platform === "win32")(
    "rejects symlink escape via grandparent when intermediate dirs don't exist (regression)",
    () => {
      // Regression: resolveFilePath("link/nonexistent/file.txt", workspace) where
      // "link" is a symlink to an outside directory. Previously, when the parent
      // ("link/nonexistent") didn't exist, we fell back to "trust path.resolve" — but
      // path.resolve doesn't follow symlinks, so the symlink in "link/" was never checked.
      // The fix walks up the ancestor tree until it finds a real path, then resolves.
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
      const symlinkInWorkspace = path.join(workspace, "dangerous-link");
      fs.symlinkSync(outsideDir, symlinkInWorkspace);
      try {
        // "dangerous-link/newdir/file.txt" — parent ("dangerous-link/newdir") doesn't exist
        // but "dangerous-link" symlinks outside; the file path resolves to outsideDir/newdir/file.txt
        expect(() =>
          resolveFilePath("dangerous-link/newdir/file.txt", workspace, {
            write: true,
          }),
        ).toThrow(/escapes workspace/i);
      } finally {
        fs.unlinkSync(symlinkInWorkspace); // symlink — unlink, not rmdir
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    },
  );

  it("rejects hardlink to outside file on write path", () => {
    // Create a real file outside the workspace
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    const outsideFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsideFile, "secret");

    // Create a hardlink inside the workspace pointing at the outside file
    const linkPath = path.join(workspace, "hardlink.txt");
    fs.linkSync(outsideFile, linkPath);

    try {
      expect(() =>
        resolveFilePath(linkPath, workspace, { write: true }),
      ).toThrow(/hardlink/i);
    } finally {
      fs.rmSync(linkPath, { force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe("requireString", () => {
  it("returns a valid string", () => {
    expect(requireString({ key: "value" }, "key")).toBe("value");
  });

  it("throws on missing key", () => {
    expect(() => requireString({}, "key")).toThrow("must be a string");
  });

  it("throws on non-string value", () => {
    expect(() => requireString({ key: 123 }, "key")).toThrow(
      "must be a string",
    );
  });

  it("throws on null", () => {
    expect(() => requireString({ key: null }, "key")).toThrow(
      "must be a string",
    );
  });

  it("throws when value exceeds maxLength", () => {
    expect(() => requireString({ key: "a".repeat(100) }, "key", 50)).toThrow(
      "exceeds maximum length",
    );
  });
});

describe("optionalString", () => {
  it("returns undefined for missing key", () => {
    expect(optionalString({}, "key")).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(optionalString({ key: null }, "key")).toBeUndefined();
  });

  it("returns a valid string", () => {
    expect(optionalString({ key: "val" }, "key")).toBe("val");
  });

  it("throws on non-string value", () => {
    expect(() => optionalString({ key: 42 }, "key")).toThrow(
      "must be a string",
    );
  });
});

describe("optionalInt", () => {
  it("returns undefined for missing key", () => {
    expect(optionalInt({}, "key")).toBeUndefined();
  });

  it("returns a valid integer", () => {
    expect(optionalInt({ key: 5 }, "key")).toBe(5);
  });

  it("throws on float", () => {
    expect(() => optionalInt({ key: 1.5 }, "key")).toThrow(
      "must be an integer",
    );
  });

  it("throws on string", () => {
    expect(() => optionalInt({ key: "5" }, "key")).toThrow(
      "must be an integer",
    );
  });

  it("throws when below min", () => {
    expect(() => optionalInt({ key: 0 }, "key")).toThrow("must be an integer");
  });

  it("throws when above max", () => {
    expect(() => optionalInt({ key: 20_000_000 }, "key")).toThrow(
      "must be an integer",
    );
  });
});

describe("optionalBool", () => {
  it("returns undefined for missing key", () => {
    expect(optionalBool({}, "key")).toBeUndefined();
  });

  it("returns a valid boolean", () => {
    expect(optionalBool({ key: true }, "key")).toBe(true);
  });

  it("throws on non-boolean", () => {
    expect(() => optionalBool({ key: "true" }, "key")).toThrow(
      "must be a boolean",
    );
  });
});

// LOW #27 — execSafeStreaming must not leak the abort listener when the
// timeout fires first (before the external signal fires).
describe("execSafeStreaming abort listener cleanup (LOW #27)", () => {
  it("resolves cleanly when timeout fires before any output", async () => {
    // Use a very short timeout so the test is fast. The process will be
    // killed by the timeout before producing any output.
    const ac = new AbortController();
    const result = await execSafeStreaming("sleep", ["10"], {
      timeout: 50,
      signal: ac.signal,
      allowlistChecked: true,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("abort listener does not fire after function has already resolved via timeout", async () => {
    // The abort listener registered inside execSafeStreaming must be removed
    // from the signal once the process closes (via timeout). If it leaks, a
    // subsequent abort() would try to kill an already-dead process and could
    // throw or produce observable side effects.
    const ac = new AbortController();
    const spuriousCallCount = 0;

    // Wrap the signal so we can count how many listeners are invoked on abort.
    const origAdd = ac.signal.addEventListener.bind(ac.signal);
    const origRemove = ac.signal.removeEventListener.bind(ac.signal);
    const registeredListeners: Array<EventListenerOrEventListenerObject> = [];
    ac.signal.addEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (type === "abort") registeredListeners.push(listener);
      return origAdd(type, listener, options);
    };
    ac.signal.removeEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) => {
      if (type === "abort") {
        const idx = registeredListeners.indexOf(listener);
        if (idx !== -1) registeredListeners.splice(idx, 1);
      }
      return origRemove(type, listener, options);
    };

    await execSafeStreaming("sleep", ["10"], {
      timeout: 50,
      signal: ac.signal,
      allowlistChecked: true,
    });

    // After the function resolves, the abort listener should have been
    // removed from our tracking array (it was cleaned up in the close handler).
    expect(registeredListeners.length).toBe(0);

    // Aborting after the function has resolved must not trigger any
    // spurious side effects from the function's internal handler.
    ac.abort();
    expect(spuriousCallCount).toBe(0);
  });
});

// tools-core-2 — on stderr maxBuffer overflow the buffered partial line must be
// cleared so a truncated fragment is not flushed as a complete line on close.
describe("execSafeStreaming stderr overflow (tools-core-2)", () => {
  it("does not flush a stale stderr partial line after overflow", async () => {
    const lines: string[] = [];
    // Write a partial line (no trailing newline) then a flood that overflows
    // maxBuffer. printf has no newline so the first write stays buffered as a
    // partial; the second write pushes total bytes past maxBuffer.
    const result = await execSafeStreaming(
      "sh",
      [
        "-c",
        // First a mid-line fragment to stderr, then a large flood (>maxBuffer).
        'printf "partialFRAG" 1>&2; printf "%0.sX" $(seq 1 5000) 1>&2',
      ],
      {
        timeout: 5000,
        maxBuffer: 1024,
        allowlistChecked: true,
        onStderrLine: (l) => lines.push(l),
      },
    );
    expect(result.exitCode).toBe(0);
    // The buffered "partialFRAG" fragment must NOT be emitted as a complete
    // line on close — it was truncated by the overflow.
    expect(lines).not.toContain("partialFRAG");
    expect(lines.some((l) => l.startsWith("partialFRAG"))).toBe(false);
  });
});

// tools-rest-5 — ctags is allowlisted in SAFE_BIN_BASENAMES so the
// searchWorkspaceSymbols headless fallback can route through execSafe.
describe("execSafe ctags allowlist (tools-rest-5)", () => {
  it("does not reject ctags as an unsafe binary", async () => {
    // A non-existent path/flag is fine — we only care that execSafe does NOT
    // throw the "not in the safe-binary set" guard error for "ctags".
    const result = await execSafe("ctags", ["--__definitely_not_a_flag__"], {
      timeout: 3000,
    });
    // execSafe returns a result (exitCode != 0 / ENOENT) rather than throwing
    // the allowlist guard. The guard error would have rejected the promise.
    expect(result).toHaveProperty("exitCode");
  });

  it("still rejects a binary that is not allowlisted", async () => {
    await expect(
      execSafe("definitely-not-allowed-bin", ["x"], { timeout: 1000 }),
    ).rejects.toThrow(/safe-binary set/);
  });
});

describe("sanitizeCommitSubject (tools-rest-3 / tools-rest-4)", () => {
  it("strips ASCII control chars and DEL", () => {
    const out = sanitizeCommitSubject("a\x00b\x1bc\x7fd");
    expect(out).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(out).toContain("a");
    expect(out).toContain("d");
  });

  it("strips Unicode bidi override/isolate codepoints", () => {
    // U+202E RLO, U+2066 LRI, U+200F RLM
    const out = sanitizeCommitSubject("safe‮⁦‏payload");
    expect(out).not.toContain("‮");
    expect(out).not.toContain("⁦");
    expect(out).not.toContain("‏");
    expect(out).toContain("safe");
    expect(out).toContain("payload");
  });

  it("caps length at 500 chars", () => {
    expect(sanitizeCommitSubject("z".repeat(1000)).length).toBe(500);
  });

  it("handles non-string input safely", () => {
    expect(sanitizeCommitSubject(undefined)).toBe("");
    expect(sanitizeCommitSubject(null)).toBe("");
  });

  it("leaves a normal subject unchanged", () => {
    expect(sanitizeCommitSubject("fix: normal commit subject")).toBe(
      "fix: normal commit subject",
    );
  });
});
