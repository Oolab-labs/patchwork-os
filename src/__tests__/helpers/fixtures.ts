/**
 * Shared test fixture builders.
 *
 * These wrap the real production types (`Config`, `ProbeResults`, `Logger`)
 * so test fixtures stay in lock-step with the source of truth. When a new
 * required field is added upstream, only this file needs updating — every
 * call site picks up the default automatically.
 *
 * Always prefer these helpers over inline literal fixtures in new tests.
 */
import os from "node:os";
import type { Config } from "../../config.js";
import { Logger } from "../../logger.js";
import type { ProbeResults } from "../../probe.js";

/** Build a fully-valid `Config` with safe defaults; override per-test. */
export function makeConfig(overrides: Partial<Config> = {}): Config {
  const workspace = overrides.workspace ?? os.tmpdir();
  const base: Config = {
    workspace,
    workspaceFolders: [workspace],
    ideName: "test",
    editorCommand: null,
    port: null,
    bindAddress: "127.0.0.1",
    verbose: false,
    jsonl: false,
    linters: [],
    commandAllowlist: [],
    commandTimeout: 30_000,
    maxResultSize: 1_000_000,
    vscodeCommandAllowlist: [],
    configFilePath: null,
    activeWorkspaceFolder: workspace,
    gracePeriodMs: 120_000,
    autoTmux: false,
    driver: "none",
    claudeBinary: "claude",
    antBinary: "ant",
    automationEnabled: false,
    automationPolicyPath: null,
    automationAllowPrivateWebhooks: false,
    toolRateLimit: 60,
    approvalGate: "off",
    enableTimeOfDayAnomaly: false,
    managedSettingsPath: null,
    approvalWebhookUrl: null,
    pushServiceUrl: null,
    pushServiceToken: null,
    pushServiceBaseUrl: null,
    ntfyTopic: null,
    ntfyServer: null,
    watch: false,
    plugins: [],
    pluginWatch: false,
    vps: false,
    db: false,
    allowPrivateHttp: false,
    fixedToken: null,
    webhookSecret: null,
    issuerUrl: null,
    oauthTokenTtlMs: 24 * 60 * 60 * 1000,
    corsOrigins: [],
    trustedProxies: [],
    auditLogPath: null,
    fullMode: true,
    maxSessions: 5,
    analyticsEnabled: null,
    githubDefaultRepo: null,
    wsPingIntervalMs: 10_000,
    lspVerbosity: "normal",
    recipeMaxConcurrency: 4,
    recipeMaxDepth: 3,
    recipeDryRun: false,
    lazyTools: false,
  };
  return { ...base, ...overrides };
}

/** Build a fully-valid `ProbeResults` with all probes false; override per-test. */
export function makeProbes(
  overrides: Partial<ProbeResults> = {},
): ProbeResults {
  const base: ProbeResults = {
    rg: false,
    fd: false,
    git: false,
    gh: false,
    tsc: false,
    eslint: false,
    pyright: false,
    ruff: false,
    cargo: false,
    go: false,
    biome: false,
    prettier: false,
    black: false,
    gofmt: false,
    rustfmt: false,
    vitest: false,
    jest: false,
    pytest: false,
    codex: false,
    universalCtags: false,
    typescriptLanguageServer: false,
    ant: false,
  };
  return { ...base, ...overrides };
}

/**
 * Minimal valid `Logger` for tests. `Logger` is a concrete class — we
 * instantiate it with quiet defaults so callers that pass it into production
 * code get the real type without flooding stdout.
 *
 * Pass `{ verbose: true }` (etc.) to override; pass any keys you want stubbed
 * out and they'll be merged onto the instance.
 */
export function makeLogger(
  overrides: Partial<Logger> & { verbose?: boolean; jsonl?: boolean } = {},
): Logger {
  const { verbose = false, jsonl = false, ...rest } = overrides;
  const logger = new Logger(verbose, jsonl);
  Object.assign(logger, rest);
  return logger;
}
