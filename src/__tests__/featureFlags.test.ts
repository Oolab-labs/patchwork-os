import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertWriteAllowed,
  isEnabled,
  KILL_SWITCH_WRITES,
  listFlags,
  loadFlags,
  registerFlag,
  setFlag,
} from "../featureFlags.js";

describe("featureFlags", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Clear test flags before each test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("registers a flag with default value", () => {
    registerFlag({
      id: "test.feature",
      description: "Test feature",
      defaultValue: false,
      category: "experimental",
      requiresOptIn: true,
    });

    expect(isEnabled("test.feature")).toBe(false);
  });

  it("allows setFlag to override default", () => {
    registerFlag({
      id: "test.togglable",
      description: "Test togglable",
      defaultValue: false,
      category: "ui",
      requiresOptIn: false,
    });

    setFlag("test.togglable", true);
    expect(isEnabled("test.togglable")).toBe(true);
  });

  it("environment variable overrides setFlag", () => {
    registerFlag({
      id: "test.env-override",
      description: "Test env override",
      defaultValue: false,
      category: "ui",
      requiresOptIn: false,
    });

    setFlag("test.env-override", false);
    process.env.PATCHWORK_FLAG_TEST_ENV_OVERRIDE = "true";

    expect(isEnabled("test.env-override")).toBe(true);
  });

  it("lists all flags with current values", () => {
    registerFlag({
      id: "test.listable",
      description: "Test listable",
      defaultValue: true,
      category: "ui",
      requiresOptIn: false,
    });

    const flags = listFlags();
    const found = flags.find((f) => f.id === "test.listable");

    expect(found).toBeDefined();
    expect(found?.currentValue).toBe(true);
  });

  it("returns false for unknown flags", () => {
    expect(isEnabled("unknown.nonexistent")).toBe(false);
  });

  it("throws on duplicate registration", () => {
    registerFlag({
      id: "test.duplicate",
      description: "First registration",
      defaultValue: false,
      category: "ui",
      requiresOptIn: false,
    });

    expect(() =>
      registerFlag({
        id: "test.duplicate",
        description: "Second registration",
        defaultValue: true,
        category: "ui",
        requiresOptIn: false,
      }),
    ).toThrow('Feature flag "test.duplicate" is already registered');
  });

  describe("kill switch", () => {
    it("blocks writes when kill switch is enabled", () => {
      setFlag(KILL_SWITCH_WRITES, true);

      expect(() => assertWriteAllowed("file.write")).toThrow(
        "Write operation blocked by kill switch",
      );
    });

    it("allows writes when kill switch is disabled", () => {
      setFlag(KILL_SWITCH_WRITES, false);

      expect(() => assertWriteAllowed("file.write")).not.toThrow();
    });
  });
});
