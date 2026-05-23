import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckResult } from "../../tools/bridgeDoctor.js";

// Mock the runBridgeHealthChecks export before importing the module under test.
vi.mock("../../tools/bridgeDoctor.js", () => ({
  runBridgeHealthChecks: vi.fn(),
}));

import { runBridgeHealthChecks } from "../../tools/bridgeDoctor.js";
import { runDoctor } from "../doctor.js";

const mockRunBridgeHealthChecks = vi.mocked(runBridgeHealthChecks);

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeChecks(overrides: Partial<CheckResult>[]): CheckResult[] {
  return overrides.map((o, i) => ({
    name: `check-${i}`,
    status: "ok" as const,
    ...o,
  }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runDoctor", () => {
  beforeEach(() => {
    mockRunBridgeHealthChecks.mockReset();
  });

  // ── ok=true when all checks pass ─────────────────────────────────────────

  it("ok=true when all checks have status ok", async () => {
    mockRunBridgeHealthChecks.mockResolvedValue(
      makeChecks([{ status: "ok" }, { status: "ok" }, { status: "ok" }]),
    );

    const result = await runDoctor({ workspace: "/fake/workspace" });

    expect(result.ok).toBe(true);
    expect(result.checks).toHaveLength(3);
    expect(result.checks.every((c) => c.status === "ok")).toBe(true);
  });

  // ── ok=false when any check is error (→ fail) ─────────────────────────────

  it("ok=false when any check has status error", async () => {
    mockRunBridgeHealthChecks.mockResolvedValue(
      makeChecks([
        { status: "ok" },
        { status: "error", name: "Workspace path", detail: "path missing" },
        { status: "ok" },
      ]),
    );

    const result = await runDoctor({ workspace: "/fake/workspace" });

    expect(result.ok).toBe(false);
    const failing = result.checks.filter((c) => c.status === "fail");
    expect(failing).toHaveLength(1);
    expect(failing[0].name).toBe("Workspace path");
    expect(failing[0].detail).toBe("path missing");
  });

  // ── ok=true when some checks are warn ────────────────────────────────────

  it("ok=true when some checks are warn (warns do not fail)", async () => {
    mockRunBridgeHealthChecks.mockResolvedValue(
      makeChecks([
        { status: "ok" },
        { status: "warn", name: "Git", detail: "not a git repo" },
        { status: "ok" },
      ]),
    );

    const result = await runDoctor({ workspace: "/fake/workspace" });

    expect(result.ok).toBe(true);
    const warns = result.checks.filter((c) => c.status === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0].name).toBe("Git");
  });

  // ── skip checks map to ok ─────────────────────────────────────────────────

  it("maps skip status to ok (non-issue)", async () => {
    mockRunBridgeHealthChecks.mockResolvedValue(
      makeChecks([
        { status: "skip", name: "Automation Policy", detail: "not configured" },
      ]),
    );

    const result = await runDoctor();

    expect(result.ok).toBe(true);
    expect(result.checks[0].status).toBe("ok");
  });

  // ── multiple fails still ok=false ────────────────────────────────────────

  it("ok=false when multiple checks fail", async () => {
    mockRunBridgeHealthChecks.mockResolvedValue(
      makeChecks([
        { status: "error", name: "Workspace path" },
        { status: "error", name: "Lock file" },
        { status: "warn", name: "Git" },
      ]),
    );

    const result = await runDoctor({ workspace: "/fake/workspace" });

    expect(result.ok).toBe(false);
    expect(result.checks.filter((c) => c.status === "fail")).toHaveLength(2);
  });

  // ── passes workspace option through ─────────────────────────────────────

  it("passes workspace and port to runBridgeHealthChecks", async () => {
    mockRunBridgeHealthChecks.mockResolvedValue([]);

    await runDoctor({ workspace: "/my/workspace", port: 3000 });

    expect(mockRunBridgeHealthChecks).toHaveBeenCalledWith("/my/workspace", {
      port: 3000,
      automationPolicyPath: undefined,
    });
  });

  // ── defaults to cwd when no workspace provided ─────────────────────────

  it("defaults workspace to process.cwd() when not provided", async () => {
    mockRunBridgeHealthChecks.mockResolvedValue([]);

    await runDoctor();

    expect(mockRunBridgeHealthChecks).toHaveBeenCalledWith(
      process.cwd(),
      expect.objectContaining({}),
    );
  });

  // ── suggestion field preserved ────────────────────────────────────────────

  it("preserves suggestion field from underlying check", async () => {
    mockRunBridgeHealthChecks.mockResolvedValue(
      makeChecks([
        {
          status: "error",
          name: "Workspace path",
          detail: "missing",
          suggestion: "Create the directory",
        },
      ]),
    );

    const result = await runDoctor({ workspace: "/fake/workspace" });

    expect(result.checks[0].suggestion).toBe("Create the directory");
  });

  // ── empty checks list → ok=true ──────────────────────────────────────────

  it("ok=true for empty check list", async () => {
    mockRunBridgeHealthChecks.mockResolvedValue([]);

    const result = await runDoctor();

    expect(result.ok).toBe(true);
    expect(result.checks).toHaveLength(0);
  });
});
