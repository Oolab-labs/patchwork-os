/**
 * Redaction by value — the cases a mutation run (Stryker, 2026-11-14) showed
 * were unpinned. Each block names what could previously be broken with every
 * test still green. The ones that matter: any single sensitive key name could
 * be dropped from the list; the base64, base64url and JSON-escaped forms of a
 * secret could stop being redacted; an overlapping shorter secret could be
 * replaced first and leave the rest of a longer one in clear; and a text value
 * shared by two runs could be released by one of them while the other ran.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetSecretValuesForTesting,
  isSensitiveKeyName,
  MIN_SECRET_LENGTH,
  redactKnownSecrets,
  redactKnownSecretsDeep,
  redactSensitiveKeysDeep,
  registerEnvBlock,
  registerSecretValue,
  registerSecretValues,
  registerTextInputValue,
  SENSITIVE_KEY_PATTERNS,
  SENSITIVE_KEY_REDACTED,
  secretValueCount,
  textInputValueCount,
} from "../secretValues.js";

beforeEach(() => _resetSecretValuesForTesting());
afterEach(() => _resetSecretValuesForTesting());

describe("key-name redaction", () => {
  const PINNED = [
    "authorization",
    "xapikey",
    "apikey",
    "password",
    "passwd",
    "secret",
    "token",
    "cookie",
    "session",
    "privatekey",
    "clientsecret",
    "refreshtoken",
    "accesstoken",
  ];

  it("keeps every pinned pattern — none can be dropped silently", () => {
    for (const p of PINNED) expect(SENSITIVE_KEY_PATTERNS).toContain(p);
  });

  it("redacts a value under each pinned name, in the spellings real configs use", () => {
    const spellings: Record<string, string> = {
      Authorization: "x",
      "X-Api-Key": "x",
      api_key: "x",
      PASSWORD: "x",
      passwd: "x",
      webhookSecret: "x",
      GH_TOKEN: "x",
      Cookie: "x",
      session_id: "x",
      "private.key": "x",
      client_secret: "x",
      "refresh-token": "x",
      accessToken: "x",
    };
    const out = redactSensitiveKeysDeep(spellings) as Record<string, string>;
    for (const k of Object.keys(spellings)) {
      expect(out[k], k).toBe(SENSITIVE_KEY_REDACTED);
    }
    expect(SENSITIVE_KEY_REDACTED).toBe("[REDACTED]");
  });

  it("leaves ordinary keys alone, walks arrays, and survives a cycle", () => {
    const o: Record<string, unknown> = {
      repo: "example/repo",
      items: [{ password: "x", name: "n" }],
    };
    o.self = o;
    const out = redactSensitiveKeysDeep(o) as Record<string, unknown>;
    expect(out.repo).toBe("example/repo");
    expect(out.items).toEqual([{ password: "[REDACTED]", name: "n" }]);
    expect(out.self).toBe("[circular]");
    expect(isSensitiveKeyName("channel")).toBe(false);
  });
});

describe("which values are registered", () => {
  it(`ignores values shorter than ${MIN_SECRET_LENGTH}, or that are short once trimmed`, () => {
    registerSecretValue("a".repeat(MIN_SECRET_LENGTH - 1), "t");
    registerSecretValue(`   ${"b".repeat(3)}     `, "t");
    expect(secretValueCount()).toBe(0);
    registerSecretValue("c".repeat(MIN_SECRET_LENGTH), "t");
    expect(secretValueCount()).toBe(1);
  });

  it("ignores a value over 16 KB, and does not count a duplicate twice", () => {
    registerSecretValue("d".repeat(16 * 1024 + 1), "t");
    expect(secretValueCount()).toBe(0);
    registerSecretValue("e".repeat(16 * 1024), "t");
    registerSecretValue("e".repeat(16 * 1024), "t");
    expect(secretValueCount()).toBe(1);
  });

  it("registers strings under sensitive keys at any depth, and every string with allKeys", () => {
    const cfg: Record<string, unknown> = {
      repo: "ordinary-value-1",
      nested: { apiKeys: ["first-secret-1", "second-secret-2"] },
    };
    cfg.loop = cfg;
    registerSecretValues(cfg, "config");
    expect(
      redactKnownSecrets(
        "a first-secret-1 b second-secret-2 c ordinary-value-1",
      ),
    ).toBe("a [REDACTED:config] b [REDACTED:config] c ordinary-value-1");
    registerSecretValues({ repo: "ordinary-value-1" }, "all", {
      allKeys: true,
    });
    expect(redactKnownSecrets("ordinary-value-1")).toBe("[REDACTED:all]");
  });

  it("registers every string in an env block whatever its key, and skips non-strings", () => {
    registerEnvBlock({ REPO: "env-value-12345", EMPTY: undefined });
    expect(secretValueCount()).toBe(1);
    expect(redactKnownSecrets("x env-value-12345 y")).toBe(
      "x [REDACTED:env] y",
    );
  });
});

describe("the forms a secret can reappear in", () => {
  // Chosen so that every encoding below is distinct from the others: it has
  // a quote and a backslash (JSON escapes them), bytes whose base64 contains
  // "+" and "/" (base64url differs), and a length that needs "=" padding.
  const secret = 'pa"ss\\w>>?ord~~!';
  const b64 = Buffer.from(secret, "utf8").toString("base64");
  const forms: Record<string, string> = {
    raw: secret,
    url: encodeURIComponent(secret),
    base64: b64,
    base64Unpadded: b64.replace(/=+$/, ""),
    base64url: Buffer.from(secret, "utf8").toString("base64url"),
    jsonEscaped: JSON.stringify(secret).slice(1, -1),
  };

  it("the fixture really exercises each form", () => {
    expect(b64).toMatch(/=$/);
    expect(b64).toMatch(/[+/]/);
    expect(new Set(Object.values(forms)).size).toBe(Object.keys(forms).length);
  });

  for (const [name, form] of Object.entries(forms)) {
    it(`redacts the ${name} form inside surrounding text`, () => {
      registerSecretValue(secret, "connector:test");
      const out = redactKnownSecrets(`before ${form} after`);
      expect(out).toBe("before [REDACTED:connector:test] after");
    });
  }

  it("redacts the secret inside JSON.stringify of a nested object", () => {
    registerSecretValue(secret, "s");
    const out = redactKnownSecrets(JSON.stringify({ a: { b: secret } }));
    expect(out).not.toContain("ss\\\\w");
    expect(out).toContain("[REDACTED:s]");
  });
});

describe("the replacement marker", () => {
  it("uses the source label, defaults an empty one, and strips characters that break it", () => {
    registerSecretValue("value-one-1234", "");
    registerSecretValue("value-two-1234", "bad[label]\nx");
    registerSecretValue("value-three-123", "y".repeat(100));
    expect(redactKnownSecrets("value-one-1234")).toBe("[REDACTED:secret]");
    expect(redactKnownSecrets("value-two-1234")).toBe("[REDACTED:badlabelx]");
    expect(redactKnownSecrets("value-three-123")).toBe(
      `[REDACTED:${"y".repeat(48)}]`,
    );
  });
});

describe("overlapping values", () => {
  it("replaces the longer secret first, so no part of it is left in clear", () => {
    registerSecretValue("abcdefgh", "short");
    registerSecretValue("abcdefgh-and-the-rest", "long");
    expect(redactKnownSecrets("x abcdefgh-and-the-rest y abcdefgh z")).toBe(
      "x [REDACTED:long] y [REDACTED:short] z",
    );
  });

  it("a text value inside a longer secret does not leave the secret's ends in clear", () => {
    const release = registerTextInputValue("operator prose here", "[TEXT]");
    registerSecretValue("KEY-operator prose here-XYZ", "s");
    expect(redactKnownSecrets("v=KEY-operator prose here-XYZ;")).toBe(
      "v=[REDACTED:s];",
    );
    release();
  });

  it("a secret inside a text value does not break the text value's replacement", () => {
    registerSecretValue("inner-secret-1", "s");
    const release = registerTextInputValue(
      "operator prose with inner-secret-1 in the middle",
      "[TEXT]",
    );
    expect(
      redactKnownSecrets(
        "log: operator prose with inner-secret-1 in the middle.",
      ),
    ).toBe("log: [TEXT].");
    release();
  });
});

describe("text input values (run-scoped)", () => {
  const prose = "a paragraph an operator handed this run";

  it("two runs holding the same text: one ending does not unredact the other", () => {
    const a = registerTextInputValue(prose, "[T]");
    const b = registerTextInputValue(prose, "[T]");
    a();
    expect(redactKnownSecrets(`x ${prose}`)).toBe("x [T]");
    a(); // a second call from the same run must not release b's hold
    expect(redactKnownSecrets(`x ${prose}`)).toBe("x [T]");
    b();
    expect(redactKnownSecrets(`x ${prose}`)).toBe(`x ${prose}`);
    expect(textInputValueCount()).toBe(0);
  });

  it("a short value is replaced only where a whole string is exactly it", () => {
    const release = registerTextInputValue("yes", "[T]");
    expect(redactKnownSecrets("yes")).toBe("[T]");
    expect(redactKnownSecrets("yesterday was fine")).toBe("yesterday was fine");
    release();
  });

  it("an empty value registers nothing", () => {
    registerTextInputValue("", "[T]")();
    expect(textInputValueCount()).toBe(0);
  });
});

describe("redactKnownSecretsDeep", () => {
  it("redacts keys and values, keeps structure, and turns a cycle into a marker", () => {
    registerSecretValue("deep-secret-123", "s");
    const when = new Date(0);
    const o: Record<string, unknown> = {
      "deep-secret-123": 1,
      list: ["deep-secret-123", 5, null],
      when,
    };
    o.me = o;
    const out = redactKnownSecretsDeep(o) as Record<string, unknown>;
    expect(Object.keys(out)).toContain("[REDACTED:s]");
    expect(out.list).toEqual(["[REDACTED:s]", 5, null]);
    expect(out.when).toBe(when);
    expect(out.me).toBe("[circular]");
  });

  it("redacts inside a string that is itself JSON", () => {
    registerSecretValue("json-inner-secret", "s");
    const out = redactKnownSecretsDeep({
      body: JSON.stringify({ token: "json-inner-secret" }),
    }) as { body: string };
    expect(JSON.parse(out.body)).toEqual({ token: "[REDACTED:s]" });
  });

  it("with only a text value registered, still walks and redacts", () => {
    const release = registerTextInputValue(
      "only a text value is registered here",
      "[T]",
    );
    expect(
      redactKnownSecretsDeep({ a: "only a text value is registered here" }),
    ).toEqual({ a: "[T]" });
    release();
  });
});
