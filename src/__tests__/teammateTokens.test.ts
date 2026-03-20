import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type StoredToken,
  generateToken,
  isValidName,
  isValidTokenFormat,
  loadTokens,
  parseToken,
  saveTokens,
  verifyToken,
} from "../teammateTokens.js";

describe("teammateTokens", () => {
  let tmpDir: string;
  let tokensPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cib-test-"));
    tokensPath = path.join(tmpDir, "tokens.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("generateToken", () => {
    it("generates a token with correct format", () => {
      const { token, stored } = generateToken("alice");
      expect(token).toMatch(/^cib_[0-9a-f]{8}_[0-9a-f]{32}$/);
      expect(stored.name).toBe("alice");
      expect(stored.identifier).toHaveLength(8);
      expect(stored.sha256Hash).toHaveLength(64);
      expect(stored.scopes).toEqual(["full"]);
      expect(stored.createdAt).toBeTruthy();
    });

    it("generates unique tokens", () => {
      const a = generateToken("alice");
      const b = generateToken("bob");
      expect(a.token).not.toBe(b.token);
      expect(a.stored.identifier).not.toBe(b.stored.identifier);
    });

    it("respects custom scopes", () => {
      const { stored } = generateToken("reader", ["read-only"]);
      expect(stored.scopes).toEqual(["read-only"]);
    });

    it("rejects invalid names", () => {
      expect(() => generateToken("")).toThrow("Invalid teammate name");
      expect(() => generateToken("a".repeat(33))).toThrow(
        "Invalid teammate name",
      );
      expect(() => generateToken("has space")).toThrow("Invalid teammate name");
      expect(() => generateToken("has@symbol")).toThrow(
        "Invalid teammate name",
      );
    });

    it("accepts valid names", () => {
      expect(() => generateToken("alice")).not.toThrow();
      expect(() => generateToken("bob-dev")).not.toThrow();
      expect(() => generateToken("agent_01")).not.toThrow();
      expect(() => generateToken("A")).not.toThrow();
    });
  });

  describe("parseToken", () => {
    it("parses a valid token", () => {
      const { token } = generateToken("alice");
      const parsed = parseToken(token);
      expect(parsed).not.toBeNull();
      expect(parsed!.identifier).toHaveLength(8);
      expect(parsed!.secret).toHaveLength(32);
    });

    it("rejects invalid formats", () => {
      expect(parseToken("")).toBeNull();
      expect(parseToken("not-a-token")).toBeNull();
      expect(parseToken("cib_short_abc")).toBeNull();
      expect(parseToken(`wrong_12345678_${"a".repeat(32)}`)).toBeNull();
    });
  });

  describe("isValidName / isValidTokenFormat", () => {
    it("validates names", () => {
      expect(isValidName("alice")).toBe(true);
      expect(isValidName("bob-2")).toBe(true);
      expect(isValidName("")).toBe(false);
      expect(isValidName("a".repeat(33))).toBe(false);
    });

    it("validates token format", () => {
      const { token } = generateToken("test");
      expect(isValidTokenFormat(token)).toBe(true);
      expect(isValidTokenFormat("bad")).toBe(false);
    });
  });

  describe("saveTokens / loadTokens", () => {
    it("round-trips tokens through disk", () => {
      const { stored: a } = generateToken("alice");
      const { stored: b } = generateToken("bob");
      const map = new Map<string, StoredToken>();
      map.set(a.identifier, a);
      map.set(b.identifier, b);

      saveTokens(tokensPath, map);
      const loaded = loadTokens(tokensPath);

      expect(loaded.size).toBe(2);
      expect(loaded.get(a.identifier)?.name).toBe("alice");
      expect(loaded.get(b.identifier)?.name).toBe("bob");
    });

    it("returns empty map for missing file", () => {
      const loaded = loadTokens("/nonexistent/path.json");
      expect(loaded.size).toBe(0);
    });

    it("creates parent directory if needed", () => {
      const nested = path.join(tmpDir, "sub", "dir", "tokens.json");
      const map = new Map<string, StoredToken>();
      const { stored } = generateToken("alice");
      map.set(stored.identifier, stored);

      saveTokens(nested, map);
      expect(fs.existsSync(nested)).toBe(true);
    });

    it("sets restrictive file permissions", () => {
      const map = new Map<string, StoredToken>();
      const { stored } = generateToken("alice");
      map.set(stored.identifier, stored);

      saveTokens(tokensPath, map);
      const stats = fs.statSync(tokensPath);
      // 0o600 = owner read/write only (as decimal: 384)
      expect(stats.mode & 0o777).toBe(0o600);
    });
  });

  describe("verifyToken", () => {
    it("verifies a valid token", () => {
      const { token, stored } = generateToken("alice");
      const map = new Map<string, StoredToken>();
      map.set(stored.identifier, stored);

      const result = verifyToken(token, map);
      expect(result).not.toBeNull();
      expect(result!.name).toBe("alice");
      expect(result!.scopes).toEqual(["full"]);
    });

    it("rejects unknown token", () => {
      const { token: tokenA } = generateToken("alice");
      const { stored: storedB } = generateToken("bob");
      const map = new Map<string, StoredToken>();
      map.set(storedB.identifier, storedB);

      expect(verifyToken(tokenA, map)).toBeNull();
    });

    it("rejects token with correct identifier but wrong secret", () => {
      const { stored } = generateToken("alice");
      const map = new Map<string, StoredToken>();
      map.set(stored.identifier, stored);

      // Forge a token with the right identifier but wrong secret
      const forged = `cib_${stored.identifier}_${"0".repeat(32)}`;
      expect(verifyToken(forged, map)).toBeNull();
    });

    it("rejects malformed tokens", () => {
      const map = new Map<string, StoredToken>();
      expect(verifyToken("", map)).toBeNull();
      expect(verifyToken("not-a-token", map)).toBeNull();
      expect(verifyToken("cib_short_x", map)).toBeNull();
    });

    it("returns null for empty token map", () => {
      const { token } = generateToken("alice");
      expect(verifyToken(token, new Map())).toBeNull();
    });

    it("round-trips through save/load/verify", () => {
      const { token, stored } = generateToken("alice", ["read-only"]);
      const map = new Map<string, StoredToken>();
      map.set(stored.identifier, stored);

      saveTokens(tokensPath, map);
      const loaded = loadTokens(tokensPath);
      const result = verifyToken(token, loaded);

      expect(result).not.toBeNull();
      expect(result!.name).toBe("alice");
      expect(result!.scopes).toEqual(["read-only"]);
    });
  });
});
