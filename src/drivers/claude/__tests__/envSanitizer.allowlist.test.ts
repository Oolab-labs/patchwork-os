import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  allowlistEnv,
  allowlistEnvDetailed,
  passEnvFromProviderOptions,
} from "../envSanitizer.js";

const HOST_ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/bin",
  HOME: "/home/op",
  USER: "op",
  LANG: "en_GB.UTF-8",
  LC_ALL: "C",
  TZ: "UTC",
  XDG_CONFIG_HOME: "/home/op/.config",
  HTTPS_PROXY: "http://proxy.example.test:3128",
  SSL_CERT_FILE: "/etc/ssl/cert.pem",
  // Secrets that must never reach a contained child.
  JIRA_API_TOKEN: "jira-secret",
  NOTION_TOKEN: "notion-secret",
  PATCHWORK_GITHUB_CLIENT_SECRET: "gh-oauth-secret",
  DASHBOARD_PASSWORD: "dash-secret",
  GITHUB_TOKEN: "ghp_secret",
  CLAUDE_IDE_BRIDGE_TOKEN: "bridge-secret",
  BRIDGE_WEBHOOK_SECRET: "hook-secret",
  PATCHWORK_HOME: "/home/op/.patchwork",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  NODE_OPTIONS: `--require ${path.join(os.tmpdir(), "evil.js")}`,
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  MCP_SERVER: "x",
  // Provider credentials.
  ANTHROPIC_API_KEY: "sk-ant-x",
  CLAUDE_CODE_OAUTH_TOKEN: "oat-x",
  GEMINI_API_KEY: "AIza-x",
  OPENAI_API_KEY: "sk-openai",
};

describe("allowlistEnv (governed containment)", () => {
  it("passes only the base allowlist when no provider keys are given", () => {
    const out = allowlistEnv(HOST_ENV);
    expect(Object.keys(out).sort()).toEqual(
      [
        "PATH",
        "HOME",
        "USER",
        "LANG",
        "LC_ALL",
        "TZ",
        "XDG_CONFIG_HOME",
        "HTTPS_PROXY",
        "SSL_CERT_FILE",
      ].sort(),
    );
  });

  it("drops every secret-shaped variable, including PATCHWORK_* and bridge tokens", () => {
    const out = allowlistEnv(HOST_ENV, {
      providerKeys: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
    });
    for (const k of [
      "JIRA_API_TOKEN",
      "NOTION_TOKEN",
      "PATCHWORK_GITHUB_CLIENT_SECRET",
      "DASHBOARD_PASSWORD",
      "GITHUB_TOKEN",
      "CLAUDE_IDE_BRIDGE_TOKEN",
      "BRIDGE_WEBHOOK_SECRET",
      "PATCHWORK_HOME",
      "AWS_SECRET_ACCESS_KEY",
      "NODE_OPTIONS",
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "MCP_SERVER",
      // OTHER providers' credentials are dropped too.
      "GEMINI_API_KEY",
      "OPENAI_API_KEY",
    ]) {
      expect(out[k], k).toBeUndefined();
    }
  });

  it("keeps exactly the provider credential the driver names", () => {
    const claude = allowlistEnv(HOST_ENV, {
      providerKeys: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
    });
    expect(claude.ANTHROPIC_API_KEY).toBe("sk-ant-x");
    expect(claude.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat-x");
    expect(claude.GEMINI_API_KEY).toBeUndefined();

    const gemini = allowlistEnv(HOST_ENV, { providerKeys: ["GEMINI_API_KEY"] });
    expect(gemini.GEMINI_API_KEY).toBe("AIza-x");
    expect(gemini.ANTHROPIC_API_KEY).toBeUndefined();
    expect(gemini.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("keeps keys the recipe explicitly declared via passEnv", () => {
    const out = allowlistEnv(HOST_ENV, { passEnv: ["JIRA_API_TOKEN"] });
    expect(out.JIRA_API_TOKEN).toBe("jira-secret");
    expect(out.NOTION_TOKEN).toBeUndefined();
  });

  it("refuses a passEnv that names a never-pass marker, and reports it", () => {
    const { env, dropped } = allowlistEnvDetailed(HOST_ENV, {
      passEnv: ["NODE_OPTIONS", "CLAUDECODE", "MCP_SERVER", "TZ"],
    });
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.MCP_SERVER).toBeUndefined();
    expect(env.TZ).toBe("UTC");
    expect(dropped.sort()).toEqual([
      "CLAUDECODE",
      "MCP_SERVER",
      "NODE_OPTIONS",
    ]);
  });

  it("does not mutate the input", () => {
    const input = { ...HOST_ENV };
    allowlistEnv(input, { providerKeys: ["OPENAI_API_KEY"] });
    expect(input).toEqual(HOST_ENV);
  });

  it("passEnvFromProviderOptions reads only string entries", () => {
    expect(passEnvFromProviderOptions(undefined)).toEqual([]);
    expect(passEnvFromProviderOptions({ passEnv: "X" })).toEqual([]);
    expect(passEnvFromProviderOptions({ passEnv: ["A", 1, "", "B"] })).toEqual([
      "A",
      "B",
    ]);
  });
});
