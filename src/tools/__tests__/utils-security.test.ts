import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { error, execSafe, findLineNumber, success } from "../utils.js";

describe("success() and error() format", () => {
  it("success returns compact JSON (no pretty-printing)", () => {
    const result = success({ key: "value", nested: { a: 1 } });
    expect(result.content).toHaveLength(1);
    const text = result.content.at(0)?.text ?? "";
    expect(text).not.toContain("\n");
    expect(text).toBe('{"key":"value","nested":{"a":1}}');
  });

  it("success does not have isError", () => {
    const result = success("ok") as any;
    expect(result.isError).toBeUndefined();
  });

  it("error returns compact JSON with isError: true", () => {
    const result = error("something failed");
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content.at(0)?.text ?? "{}");
    expect(parsed.error).toBe("something failed");
    expect(parsed.code).toBeUndefined();
  });

  it("error with optional code field (string message)", () => {
    const result = error("not found", "file_not_found");
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content.at(0)?.text ?? "{}");
    expect(parsed.error).toBe("not found");
    expect(parsed.code).toBe("file_not_found");
  });

  it("error with object payload (legacy structured errors)", () => {
    const result = error({ fixed: false, source: "cli", error: "lint failed" });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content.at(0)?.text ?? "{}");
    expect(parsed.fixed).toBe(false);
    expect(parsed.error).toBe("lint failed");
    expect(parsed.code).toBeUndefined();
  });

  it("error with object payload plus code", () => {
    const result = error(
      { fixed: false, error: "lint failed" },
      "external_command_failed",
    );
    const parsed = JSON.parse(result.content.at(0)?.text ?? "{}");
    expect(parsed.code).toBe("external_command_failed");
  });

  it("success with null", () => {
    expect(success(null).content.at(0)?.text).toBe("null");
  });
});

describe("findLineNumber (async)", () => {
  it("finds text on the correct line", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "utils-test-"));
    const file = path.join(tmpDir, "test.txt");
    fs.writeFileSync(file, "line one\nline two\nline three\n");
    try {
      expect(await findLineNumber(file, "line two")).toBe(2);
      expect(await findLineNumber(file, "line one")).toBe(1);
      expect(await findLineNumber(file, "three")).toBe(3);
    } finally {
      fs.unlinkSync(file);
      fs.rmdirSync(tmpDir);
    }
  });

  it("returns null for text not found", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "utils-test-"));
    const file = path.join(tmpDir, "test.txt");
    fs.writeFileSync(file, "hello\nworld\n");
    try {
      expect(await findLineNumber(file, "nonexistent")).toBeNull();
    } finally {
      fs.unlinkSync(file);
      fs.rmdirSync(tmpDir);
    }
  });

  it("returns null for non-existent file", async () => {
    expect(
      await findLineNumber("/tmp/nonexistent-file-12345.txt", "text"),
    ).toBeNull();
  });
});

describe("execSafe — sink-side binary allowlist (CodeQL #14)", () => {
  // Closes CodeQL js/shell-command-injection-from-environment by attaching
  // the safe-binary check to the sink itself. Callers gating on their own
  // allowlist (runCommand, terminal fallback) opt out via allowlistChecked.

  it("rejects an unknown binary by basename", async () => {
    await expect(execSafe("rm", ["-rf", "/tmp/x"])).rejects.toThrow(
      /not in the safe-binary set/,
    );
  });

  it("rejects an absolute-path unknown binary by basename", async () => {
    await expect(execSafe("/usr/bin/curl", ["https://evil"])).rejects.toThrow(
      /not in the safe-binary set/,
    );
  });

  it("error message names the rejected command for clear diagnostics", async () => {
    await expect(execSafe("nope-binary-xyz", [])).rejects.toThrow(
      /"nope-binary-xyz"/,
    );
  });

  it("accepts an allowlisted basename (git --version)", async () => {
    const result = await execSafe("git", ["--version"], { timeout: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^git version /);
  });

  it("accepts an absolute path whose basename is allowlisted", async () => {
    // `path.basename("/usr/bin/git") === "git"` — allowlist gate accepts.
    // The actual spawn may ENOENT on this host but that's a non-throw error
    // captured in the result; the assertion is that the gate didn't throw.
    const result = await execSafe("/usr/bin/git", ["--version"], {
      timeout: 5000,
    });
    expect(typeof result.exitCode).toBe("number");
  });

  it("bypasses the allowlist when allowlistChecked:true is passed", async () => {
    // `echo` is not in SAFE_BIN_BASENAMES; allowlistChecked lets it through.
    // This is the path used by runCommand / terminal after their own gate.
    const result = await execSafe("echo", ["hello"], {
      timeout: 5000,
      allowlistChecked: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });
});
