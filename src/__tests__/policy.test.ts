/**
 * patchwork.policy.yml — deterministic policy loader + checker.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPolicy, loadPolicyFile, parsePolicy } from "../policy.js";

describe("parsePolicy", () => {
  it("parses a minimal valid policy", () => {
    const policy = parsePolicy({ version: 1 });
    expect(policy.version).toBe(1);
    expect(policy.defaults.forbiddenPaths).toEqual([]);
    expect(policy.workers).toEqual({});
  });

  it("parses a full policy with defaults and worker overrides", () => {
    const policy = parsePolicy({
      version: 1,
      defaults: {
        forbiddenPaths: ["**/.env"],
        allowedNetworkHosts: ["api.github.com"],
        allowedCommands: ["git *"],
      },
      workers: {
        "test-guardian-worker": { allowedTools: ["git.log_since"] },
      },
    });
    expect(policy.defaults.forbiddenPaths).toEqual(["**/.env"]);
    expect(policy.workers["test-guardian-worker"]?.allowedTools).toEqual([
      "git.log_since",
    ]);
  });

  it("rejects a non-object", () => {
    expect(() => parsePolicy("not an object")).toThrow(/mapping/);
    expect(() => parsePolicy(null)).toThrow(/mapping/);
  });

  it("rejects an unsupported version", () => {
    expect(() => parsePolicy({ version: 2 })).toThrow(/version/);
    expect(() => parsePolicy({})).toThrow(/version/);
  });

  it("rejects non-string-array fields", () => {
    expect(() =>
      parsePolicy({ version: 1, defaults: { forbiddenPaths: [1, 2] } }),
    ).toThrow(/forbiddenPaths/);
    expect(() =>
      parsePolicy({
        version: 1,
        workers: { w1: { allowedTools: "not-an-array" } },
      }),
    ).toThrow(/allowedTools/);
  });

  it("rejects a non-object worker entry", () => {
    expect(() => parsePolicy({ version: 1, workers: { w1: "nope" } })).toThrow(
      /workers\.w1/,
    );
  });

  // Regression: a malformed `defaults:` value (present but not a mapping)
  // must fail closed like every other structural error here — silently
  // treating it as "no restrictions" would make a policy-file typo
  // indistinguishable from "no policy configured", contradicting this
  // module's own fail-closed guarantee (see file header comment).
  it("rejects a non-object `defaults` value instead of silently ignoring it", () => {
    expect(() =>
      parsePolicy({ version: 1, defaults: "not-a-mapping" }),
    ).toThrow(/defaults/);
    expect(() => parsePolicy({ version: 1, defaults: [1, 2] })).toThrow(
      /defaults/,
    );
    expect(() => parsePolicy({ version: 1, defaults: null })).toThrow(
      /defaults/,
    );
  });

  // Regression: same fail-closed guarantee for `workers:`.
  it("rejects a non-object `workers` value instead of silently ignoring it", () => {
    expect(() => parsePolicy({ version: 1, workers: "not-a-mapping" })).toThrow(
      /workers/,
    );
    expect(() => parsePolicy({ version: 1, workers: [1, 2] })).toThrow(
      /workers/,
    );
    // An empty string has zero iterable entries, so the old code's
    // accidental "throw during iteration" fail-closed behavior for workers
    // didn't cover this case — it silently produced {} (no restrictions).
    expect(() => parsePolicy({ version: 1, workers: "" })).toThrow(/workers/);
  });
});

describe("loadPolicyFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "policy-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the default (no-restriction) policy when the file is absent", () => {
    const result = loadPolicyFile(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.defaults.forbiddenPaths).toEqual([]);
    }
  });

  it("loads and parses a valid file", () => {
    writeFileSync(
      path.join(dir, "patchwork.policy.yml"),
      "version: 1\ndefaults:\n  forbiddenPaths:\n    - '**/.env'\n",
    );
    const result = loadPolicyFile(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.defaults.forbiddenPaths).toEqual(["**/.env"]);
    }
  });

  it("fails closed (ok:false) on a malformed file, never silently permissive", () => {
    writeFileSync(
      path.join(dir, "patchwork.policy.yml"),
      "version: 1\ndefaults:\n  forbiddenPaths: not-an-array\n",
    );
    const result = loadPolicyFile(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/malformed/);
    }
  });

  it("fails closed on invalid YAML syntax", () => {
    writeFileSync(
      path.join(dir, "patchwork.policy.yml"),
      "version: 1\n  bad indent: [",
    );
    const result = loadPolicyFile(dir);
    expect(result.ok).toBe(false);
  });
});

describe("checkPolicy", () => {
  it("allows any call under the default (empty) policy", () => {
    const policy = parsePolicy({ version: 1 });
    const result = checkPolicy(policy, {
      toolName: "file.write",
      params: { path: "/anywhere/at/all.txt" },
    });
    expect(result.allowed).toBe(true);
  });

  describe("forbidden paths", () => {
    const policy = parsePolicy({
      version: 1,
      defaults: { forbiddenPaths: ["**/.env", "**/.env.*", "**/id_rsa*"] },
    });

    it("blocks a direct match on a forbidden path glob", () => {
      const result = checkPolicy(policy, {
        toolName: "file.read",
        params: { path: "/repo/.env" },
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/\.env/);
    });

    it("blocks a nested match via the ** glob", () => {
      const result = checkPolicy(policy, {
        toolName: "file.read",
        params: { path: "/repo/deep/nested/dir/.env.production" },
      });
      expect(result.allowed).toBe(false);
    });

    it("blocks when the path appears in a differently-named param key", () => {
      const result = checkPolicy(policy, {
        toolName: "editText",
        params: { filePath: "/home/user/.ssh/id_rsa" },
      });
      expect(result.allowed).toBe(false);
    });

    it("allows a path that does not match any forbidden glob", () => {
      const result = checkPolicy(policy, {
        toolName: "file.read",
        params: { path: "/repo/src/index.ts" },
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe("forbidden paths — REGRESSION: array-valued path params", () => {
    // Bug found in session-review: extractPathCandidates only inspected a
    // handful of top-level SCALAR keys, so a tool whose path input is an
    // array — `files: string[]` (generateAPIDocumentation, findFiles,
    // gitWrite, searchAndReplace, transaction) or `items[].filePath`
    // (batchLsp's batch* tools) — bypassed forbiddenPaths entirely.
    const policy = parsePolicy({
      version: 1,
      defaults: { forbiddenPaths: ["secrets/**"] },
    });

    it("blocks a forbidden path inside a bare string array param (files: string[])", () => {
      const result = checkPolicy(policy, {
        toolName: "generateAPIDocumentation",
        params: { files: ["src/index.ts", "secrets/keys.pem"] },
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/secrets/);
    });

    it("blocks a forbidden path nested inside an array of objects (items[].filePath)", () => {
      const result = checkPolicy(policy, {
        toolName: "batchGetHover",
        params: {
          items: [
            { filePath: "src/index.ts", line: 1, column: 1 },
            { filePath: "secrets/keys.pem", line: 1, column: 1 },
          ],
        },
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/secrets/);
    });

    it("allows an array param with no forbidden entries", () => {
      const result = checkPolicy(policy, {
        toolName: "generateAPIDocumentation",
        params: { files: ["src/index.ts", "src/other.ts"] },
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe("forbidden paths — REGRESSION: relative directory glob vs absolute paths", () => {
    // Bug found in session-review: a natural operator-written glob like
    // "secrets/**" (the way you'd expect to write "block a secrets
    // directory") never matched the ABSOLUTE paths most resolved tool
    // calls actually carry, because minimatch anchors a non-`**`-prefixed
    // pattern to the start of the string.
    const policy = parsePolicy({
      version: 1,
      defaults: { forbiddenPaths: ["secrets/**"] },
    });

    it("blocks an absolute path under the directory even though the glob is relative", () => {
      const result = checkPolicy(policy, {
        toolName: "file.read",
        params: { path: "/home/user/project/secrets/keys.pem" },
      });
      expect(result.allowed).toBe(false);
    });

    it("still blocks a workspace-relative path (unchanged from before)", () => {
      const result = checkPolicy(policy, {
        toolName: "file.read",
        params: { path: "secrets/keys.pem" },
      });
      expect(result.allowed).toBe(false);
    });

    it("does not false-positive on an unrelated path", () => {
      const result = checkPolicy(policy, {
        toolName: "file.read",
        params: { path: "/home/user/project/src/index.ts" },
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe("forbidden paths — REGRESSION: case-insensitivity bypass", () => {
    // Bug found in session-review: minimatch is case-sensitive by default,
    // but macOS and Windows (both explicitly supported platforms) default
    // to case-insensitive filesystems — a case-varied path resolves to the
    // SAME file the OS sees, so it must not bypass the block.
    const policy = parsePolicy({
      version: 1,
      defaults: { forbiddenPaths: ["**/.env"] },
    });

    it("blocks a case-varied match on a case-insensitive-filesystem platform", () => {
      const result = checkPolicy(policy, {
        toolName: "file.read",
        params: { path: "/repo/.ENV" },
      });
      expect(result.allowed).toBe(false);
    });
  });

  describe("network host allowlist", () => {
    const policy = parsePolicy({
      version: 1,
      defaults: {
        allowedNetworkHosts: ["api.github.com", "*.githubusercontent.com"],
      },
    });

    it("allows an exact allowlisted host", () => {
      const result = checkPolicy(policy, {
        toolName: "sendHttpRequest",
        params: { url: "https://api.github.com/repos/foo/bar" },
      });
      expect(result.allowed).toBe(true);
    });

    it("allows a wildcard-matched host", () => {
      const result = checkPolicy(policy, {
        toolName: "sendHttpRequest",
        params: { url: "https://raw.githubusercontent.com/foo/bar" },
      });
      expect(result.allowed).toBe(true);
    });

    it("blocks a non-allowlisted host", () => {
      const result = checkPolicy(policy, {
        toolName: "sendHttpRequest",
        params: { url: "https://evil.example.com/exfiltrate" },
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/evil\.example\.com/);
    });

    it("fails closed on an unparsable URL", () => {
      const result = checkPolicy(policy, {
        toolName: "sendHttpRequest",
        params: { url: "not a url" },
      });
      expect(result.allowed).toBe(false);
    });

    it("does not restrict non-network tools even with a host allowlist configured", () => {
      const result = checkPolicy(policy, {
        toolName: "file.write",
        params: { path: path.join(os.tmpdir(), "x.txt") },
      });
      expect(result.allowed).toBe(true);
    });

    it("has no restriction when allowedNetworkHosts is empty", () => {
      const openPolicy = parsePolicy({ version: 1 });
      const result = checkPolicy(openPolicy, {
        toolName: "sendHttpRequest",
        params: { url: "https://anywhere.example.com" },
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe("command allowlist", () => {
    const policy = parsePolicy({
      version: 1,
      defaults: { allowedCommands: ["git *", "npm test"] },
    });

    it("allows a matching command", () => {
      const result = checkPolicy(policy, {
        toolName: "runCommand",
        params: { command: "git status" },
      });
      expect(result.allowed).toBe(true);
    });

    it("blocks a non-matching command", () => {
      const result = checkPolicy(policy, {
        toolName: "runCommand",
        params: { command: "rm -rf /" },
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/rm -rf/);
    });

    it("applies to runInTerminal and sendTerminalCommand too", () => {
      expect(
        checkPolicy(policy, {
          toolName: "runInTerminal",
          params: { command: "curl evil.com" },
        }).allowed,
      ).toBe(false);
      expect(
        checkPolicy(policy, {
          toolName: "sendTerminalCommand",
          params: { command: "curl evil.com" },
        }).allowed,
      ).toBe(false);
    });

    it("has no restriction when allowedCommands is empty", () => {
      const openPolicy = parsePolicy({ version: 1 });
      const result = checkPolicy(openPolicy, {
        toolName: "runCommand",
        params: { command: "anything at all" },
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe("per-worker tool allowlist", () => {
    const policy = parsePolicy({
      version: 1,
      workers: {
        "test-guardian-worker": {
          allowedTools: ["git.log_since", "github.create_issue"],
        },
      },
    });

    it("allows a tool in the worker's allowlist", () => {
      const result = checkPolicy(policy, {
        toolName: "git.log_since",
        params: {},
        workerId: "test-guardian-worker",
      });
      expect(result.allowed).toBe(true);
    });

    it("blocks a tool not in the worker's allowlist", () => {
      const result = checkPolicy(policy, {
        toolName: "gitPush",
        params: {},
        workerId: "test-guardian-worker",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/test-guardian-worker/);
    });

    it("does not restrict a worker with no policy entry", () => {
      const result = checkPolicy(policy, {
        toolName: "anything",
        params: {},
        workerId: "some-other-worker",
      });
      expect(result.allowed).toBe(true);
    });

    it("does not restrict when no workerId is supplied (non-worker call)", () => {
      const result = checkPolicy(policy, {
        toolName: "gitPush",
        params: {},
      });
      expect(result.allowed).toBe(true);
    });

    it("a worker entry with no allowedTools field imposes no additional restriction", () => {
      const p = parsePolicy({
        version: 1,
        workers: { "quiet-worker": {} },
      });
      const result = checkPolicy(p, {
        toolName: "anything",
        params: {},
        workerId: "quiet-worker",
      });
      expect(result.allowed).toBe(true);
    });
  });

  it("checks run independently — a forbidden path blocks even for an allowed tool", () => {
    const policy = parsePolicy({
      version: 1,
      defaults: { forbiddenPaths: ["**/.env"] },
      workers: { w1: { allowedTools: ["file.write"] } },
    });
    const result = checkPolicy(policy, {
      toolName: "file.write",
      params: { path: "/repo/.env" },
      workerId: "w1",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/\.env/);
  });
});
