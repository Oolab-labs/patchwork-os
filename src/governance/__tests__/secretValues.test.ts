/**
 * secretValues — adversarial tests for VALUE-based redaction.
 *
 * Every test embeds a random secret somewhere key-based redaction cannot
 * see it, and asserts the secret (and its cheap encodings) never reaches
 * the sink. A test here that could pass with the registry disabled is a
 * test of nothing, so each block first proves the leak is real without it.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalQueue } from "../../approvalQueue.js";
import { captureForRunlog } from "../../recipes/stepObservation.js";
import {
  _resetSecretValuesForTesting,
  MIN_SECRET_LENGTH,
  redactKnownSecrets,
  redactKnownSecretsDeep,
  registerBridgeToken,
  registerEnvBlock,
  registerSecretValue,
  registerSecretValues,
  secretValueCount,
} from "../secretValues.js";

function freshSecret(): string {
  // 32 chars, URL-safe-ish but with a `+` and `/` so URL-encoding and
  // base64 differ from the raw form.
  return `${randomBytes(12).toString("hex")}+/${randomBytes(3).toString("hex")}`;
}

function encodingsOf(secret: string): string[] {
  return [
    secret,
    encodeURIComponent(secret),
    Buffer.from(secret).toString("base64"),
    Buffer.from(secret).toString("base64url"),
    JSON.stringify(secret).slice(1, -1),
  ];
}

function expectClean(haystack: string, secret: string): void {
  for (const enc of encodingsOf(secret)) {
    expect(
      haystack,
      `leaked encoding ${enc === secret ? "raw" : "derived"}`,
    ).not.toContain(enc);
  }
}

beforeEach(() => _resetSecretValuesForTesting());
afterEach(() => _resetSecretValuesForTesting());

describe("registry hygiene", () => {
  it("ignores values shorter than the minimum length", () => {
    registerSecretValue("short", "env");
    registerSecretValue("a".repeat(MIN_SECRET_LENGTH - 1), "env");
    expect(secretValueCount()).toBe(0);
    registerSecretValue("a".repeat(MIN_SECRET_LENGTH), "env");
    expect(secretValueCount()).toBe(1);
  });

  it("never reveals a value through JSON.stringify or util.inspect of the module", async () => {
    const secret = freshSecret();
    registerSecretValue(secret, "env");
    const mod = await import("../secretValues.js");
    expectClean(JSON.stringify(mod), secret);
    expectClean(inspect(mod, { depth: 10, showHidden: true }), secret);
  });

  it("marker names the source, never the key or the value", () => {
    const secret = freshSecret();
    registerSecretValues({ API_KEY: secret }, "connector:mail");
    const out = redactKnownSecrets(`x=${secret}`);
    expect(out).toBe("x=[REDACTED:connector:mail]");
    expect(out).not.toContain("API_KEY");
  });

  it("returns the same reference when nothing is registered", () => {
    const s = "nothing to do here at all";
    expect(redactKnownSecrets(s)).toBe(s);
    const o = { a: 1 };
    expect(redactKnownSecretsDeep(o)).toBe(o);
  });

  it("longest match first — a prefix secret never exposes the tail of a longer one", () => {
    const long = `${freshSecret()}TAIL_${randomBytes(4).toString("hex")}`;
    const short = long.slice(0, 20);
    registerSecretValue(short, "a");
    registerSecretValue(long, "b");
    expect(redactKnownSecrets(`v=${long}`)).toBe("v=[REDACTED:b]");
  });
});

describe("captureForRunlog — value-based redaction (the audit's leak)", () => {
  it("leaks without the registry, to prove the fixture is adversarial", () => {
    const secret = freshSecret();
    const json = JSON.stringify(
      captureForRunlog({ body: `{"key":"${secret}"}` }),
    );
    expect(json).toContain(secret);
  });

  it("(i) object value under a non-sensitive key", () => {
    const secret = freshSecret();
    registerEnvBlock({ SOME_NAME: secret });
    expectClean(JSON.stringify(captureForRunlog({ note: secret })), secret);
  });

  it("(ii) nested JSON string", () => {
    const secret = freshSecret();
    registerSecretValue(secret, "env");
    const inner = JSON.stringify({ auth: { k: secret } });
    const outer = JSON.stringify({ payload: inner });
    const out = JSON.stringify(captureForRunlog({ body: outer }));
    expectClean(out, secret);
    expect(out).toContain("REDACTED:env");
  });

  it("(iii) URL query, raw and URL-encoded", () => {
    const secret = freshSecret();
    registerSecretValue(secret, "env");
    const url = `https://example.test/v1?key=${encodeURIComponent(secret)}&raw=${secret}`;
    expectClean(JSON.stringify(captureForRunlog({ url })), secret);
  });

  it("(iv) HTTP body string", () => {
    const secret = freshSecret();
    registerSecretValue(secret, "env");
    const out = captureForRunlog({
      method: "POST",
      body: `grant_type=client_credentials&client_secret=${secret}`,
    }) as { body: string };
    expectClean(JSON.stringify(out), secret);
    expect(out.body).toContain("[REDACTED:env]");
  });

  it("(v) base64 and base64url forms, e.g. a Basic auth header", () => {
    const secret = freshSecret();
    registerSecretValue(secret, "connector:x");
    const basic = Buffer.from(`user:${secret}`).toString("base64");
    const out = JSON.stringify(
      captureForRunlog({
        note: `Basic ${Buffer.from(secret).toString("base64")}`,
        alt: Buffer.from(secret).toString("base64url"),
        composite: basic,
      }),
    );
    expectClean(out, secret);
  });

  it("object KEYS carrying a secret are redacted too", () => {
    const secret = freshSecret();
    registerSecretValue(secret, "env");
    const out = JSON.stringify(captureForRunlog({ [secret]: "v" }));
    expectClean(out, secret);
  });

  it("does not throw on invalid JSON-looking strings", () => {
    const secret = freshSecret();
    registerSecretValue(secret, "env");
    const out = redactKnownSecretsDeep({ s: `{not json ${secret}` }) as {
      s: string;
    };
    expectClean(out.s, secret);
  });
});

describe("approval record built from secret-bearing params", () => {
  it("does not contain the secret in params or summary", () => {
    const secret = freshSecret();
    registerSecretValue(secret, "env");
    const q = new ApprovalQueue();
    const { callId } = q.request({
      toolName: "http.post",
      tier: "medium",
      params: {
        url: `https://example.test/?k=${secret}`,
        body: JSON.stringify({ nested: { token_like: secret } }),
      },
      summary: `POST with ${secret}`,
    });
    const entry = q.list().find((e) => e.callId === callId);
    expect(entry).toBeDefined();
    expectClean(JSON.stringify(entry), secret);
    expect(entry?.summary).toContain("[REDACTED:env]");
    q.cancel(callId);
  });
});

describe("orchestrator persistence", () => {
  let home: string;
  let cwd: string;
  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "secretvalues-orch-"));
    // The bridge creates `<configDir>/ide` at startup; the orchestrator's
    // best-effort flush does not, and swallows the ENOENT.
    mkdirSync(path.join(home, "ide"), { recursive: true });
    cwd = process.cwd();
    process.env.PATCHWORK_HOME = home;
    process.env.CLAUDE_CONFIG_DIR = home;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    vi.resetModules();
  });
  afterEach(() => {
    process.env.PATCHWORK_HOME = undefined;
    process.env.CLAUDE_CONFIG_DIR = undefined;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = undefined;
    process.chdir(cwd);
    rmSync(home, { recursive: true, force: true });
  });

  it("writes no clear-text prompt or output, and restores the full prompt", async () => {
    const secret = freshSecret();
    const { registerSecretValue: reg } = await import("../secretValues.js");
    reg(secret, "env");
    const { ClaudeOrchestrator } = await import("../../claudeOrchestrator.js");
    const fs = await import("node:fs");
    const driver = {
      name: "instant",
      async run() {
        return { text: `echo ${secret}`, exitCode: 0, durationMs: 1 };
      },
    };
    const orch = new ClaudeOrchestrator(driver as any, home, () => {});
    const prompt = `use key ${secret} to call the api`;
    const { id } = await orch.runAndWait({ prompt });
    orch.flushTasksToDisk(41999);

    const written = path.join(home, "ide", "tasks-41999.json");
    expect(fs.existsSync(written), "tasks file not written").toBe(true);
    const raw = fs.readFileSync(written, "utf-8");
    expectClean(raw, secret);
    expect(raw).not.toContain(prompt);
    const parsed = JSON.parse(raw) as {
      tasks: Array<Record<string, unknown>>;
    };
    const row = parsed.tasks.find((t) => t.id === id);
    expect(row?.prompt).toBeUndefined();
    expect(typeof row?.promptSha256).toBe("string");
    expect(String(row?.promptPreview)).toContain("[REDACTED:env]");
    expect(typeof row?.promptEncrypted).toBe("string");

    const orch2 = new ClaudeOrchestrator(driver as any, home, () => {});
    await orch2.loadPersistedTasks(41999);
    expect(orch2.getTask(id)?.prompt).toBe(prompt);
    fs.rmSync(written, { force: true });
  });
});

describe("bridge token", () => {
  it("is redacted from a formatted log line", () => {
    const token = freshSecret();
    registerBridgeToken(token);
    expect(redactKnownSecrets(`auth=${token}`)).toBe(
      "auth=[REDACTED:bridge-token]",
    );
  });
});
