import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetActiveProfileForTesting,
  GOVERNED_PROFILE,
  setActiveProfile,
} from "../../governance/profile.js";
import {
  type AgentExecutorDeps,
  executeAgent,
  stepSandboxRequest,
} from "../agentExecutor.js";

function makeDeps(
  overrides: Partial<AgentExecutorDeps> = {},
): AgentExecutorDeps {
  return {
    anthropicFn: vi.fn().mockResolvedValue({ text: "a" }),
    providerDriverFn: vi
      .fn()
      .mockImplementation((driver: string) =>
        Promise.resolve({ text: `${driver}-result` }),
      ),
    claudeCliFn: vi.fn().mockResolvedValue({ text: "cli" }),
    localFn: vi.fn().mockResolvedValue({ text: "l" }),
    probeClaudeCli: vi.fn().mockReturnValue(false),
    loadPatchworkConfig: vi.fn().mockReturnValue({}),
    ...overrides,
  };
}

afterEach(() => _resetActiveProfileForTesting());

describe("executeAgent — agent containment (Phase 0 step 6)", () => {
  it("compat, no sandbox: claudeCliFn receives no opts and no containment (unchanged shape)", async () => {
    const deps = makeDeps();
    const r = await executeAgent({ driver: "subprocess", prompt: "p" }, deps);
    expect(deps.claudeCliFn).toHaveBeenCalledWith("p", undefined);
    expect(r.containment).toBeUndefined();
  });

  it("governed: claudeCliFn receives an enforced containment and the result carries it", async () => {
    setActiveProfile(GOVERNED_PROFILE);
    const deps = makeDeps();
    const r = await executeAgent({ driver: "subprocess", prompt: "p" }, deps);
    const opts = vi.mocked(deps.claudeCliFn).mock.calls[0]![1]!;
    expect(opts.containment?.enforced).toBe(true);
    expect(opts.containment?.allowedTools.sort()).toEqual(
      ["Glob", "Grep", "LS", "Read"].sort(),
    );
    expect(opts.containment?.deniedTools).toEqual(
      expect.arrayContaining(["WebFetch", "WebSearch", "Bash"]),
    );
    expect(opts.containment?.envAllowlist).toBe(true);
    expect(opts.containment?.mcpAccess).toBe(false);
    expect(r.containment?.enforced).toBe(true);
  });

  it("governed: object-form sandbox widens and is reported; legacy sandbox flag stays boolean", async () => {
    setActiveProfile(GOVERNED_PROFILE);
    const deps = makeDeps();
    await executeAgent(
      {
        driver: "subprocess",
        prompt: "p",
        sandbox: { network: true, mcpAccess: true },
      },
      deps,
    );
    const opts = vi.mocked(deps.claudeCliFn).mock.calls[0]![1]!;
    expect(opts.sandbox).toBe(true);
    expect(opts.containment?.widenings).toEqual(["network", "mcpAccess"]);
    expect(opts.containment?.deniedTools).toEqual(["Bash"]);
    expect(opts.containment?.mcpAccess).toBe(true);
  });

  it("governed: gemini/codex get providerOptions.containment; compat keeps the 3-arg call", async () => {
    setActiveProfile(GOVERNED_PROFILE);
    const deps = makeDeps();
    await executeAgent({ driver: "codex", prompt: "p" }, deps);
    const call = vi.mocked(deps.providerDriverFn).mock.calls[0]!;
    expect(
      (call[3] as { containment?: { enforced: boolean } }).containment
        ?.enforced,
    ).toBe(true);

    _resetActiveProfileForTesting();
    const compat = makeDeps();
    await executeAgent({ driver: "codex", prompt: "p" }, compat);
    expect(vi.mocked(compat.providerDriverFn).mock.calls[0]!.length).toBe(3);
  });

  it("stepSandboxRequest maps both sandbox forms to one request", () => {
    expect(
      stepSandboxRequest({ sandbox: true, allowedTools: ["Read"] }),
    ).toEqual({ sandbox: true, allowedTools: ["Read"] });
    expect(
      stepSandboxRequest({ sandbox: { shell: true }, mcpAccess: false }),
    ).toEqual({ sandbox: true, shell: true, mcpAccess: false });
    expect(stepSandboxRequest({})).toEqual({ sandbox: false });
  });
});
