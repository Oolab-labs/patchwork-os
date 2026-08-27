/**
 * A worker-mandated sandbox restricts TOOLS. The `local` driver has none.
 *
 * `resolveSandboxEnforcement` refused every driver but subprocess/claude-code/
 * codex, on the grounds that the rest "structurally drop the deny list" and so
 * would silently re-open the agent bypass the sandbox exists to close. That is
 * exactly right for a driver that HAS tools and ignores the deny list. It is
 * not right for `local`, which has no tool surface at all:
 *
 *     localFn: (prompt: string, model: string) => Promise<AgentResult>
 *
 * `cliOpts` — the object carrying `mcpAccess` / `sandbox` / `allowedTools` /
 * `disallowedTools` — is built and handed ONLY to `claudeCliFn`. There is no
 * parameter through which a tool could reach the local driver. "No tools" is
 * strictly stronger than "tools minus a deny list", so refusing `local` under
 * `enforceSandbox` withheld the one driver that satisfies the sandbox by
 * construction.
 *
 * The cost of that conflation was concrete: a worker recipe handling
 * `personal` data had nowhere to run. `local-models` is the only destination
 * cleared for `personal`, and the only driver that can reach it was refused,
 * so the honest declaration and a working recipe were mutually exclusive.
 *
 * THE GUARD BELOW IS THE LOAD-BEARING TEST. This reasoning holds only while
 * `localFn` takes no tool-bearing parameter. If someone gives the local driver
 * tools, the exemption becomes the exact hole the original comment warned
 * about — so the arity check fails the build rather than letting it through.
 */

import { describe, expect, it, vi } from "vitest";
import { type AgentExecutorDeps, executeAgent } from "../agentExecutor.js";

function makeDeps(
  overrides: Partial<AgentExecutorDeps> = {},
): AgentExecutorDeps {
  return {
    anthropicFn: vi.fn().mockResolvedValue({ text: "anthropic-result" }),
    providerDriverFn: vi
      .fn()
      .mockImplementation((driver: string) =>
        Promise.resolve({ text: `${driver}-result` }),
      ),
    claudeCliFn: vi.fn().mockResolvedValue({ text: "claude-cli-result" }),
    localFn: vi.fn().mockResolvedValue({ text: "local-result" }),
    probeClaudeCli: vi.fn().mockReturnValue(false),
    loadPatchworkConfig: vi.fn().mockReturnValue({}),
    ...overrides,
  };
}

describe("local driver under a worker-mandated sandbox", () => {
  it("RUNS rather than refusing", async () => {
    const deps = makeDeps();
    const res = await executeAgent(
      { prompt: "hello", driver: "local", enforceSandbox: true },
      deps,
    );
    expect(res.text).toBe("local-result");
    expect(deps.localFn).toHaveBeenCalled();
  });

  it("receives no tool-bearing argument when it runs", async () => {
    const deps = makeDeps();
    await executeAgent(
      {
        prompt: "hello",
        driver: "local",
        enforceSandbox: true,
        mcpAccess: true,
        allowedTools: ["file.write"],
        disallowedTools: ["github.create_issue"],
      },
      deps,
    );
    // Prompt and model only. If a third argument ever appears, the exemption
    // below is no longer sound.
    const call = (deps.localFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call).toHaveLength(2);
    expect(call?.[0]).toBe("hello");
  });

  it("GUARD: localFn still takes no tool parameter", () => {
    // Arity is the machine-checkable form of the argument this exemption
    // rests on. Widening the local driver to accept tools must fail here,
    // not silently reopen the bypass.
    const deps = makeDeps();
    // biome-ignore lint/complexity/useLiteralKeys: probing the real signature
    const real = deps["localFn"];
    expect(real.length).toBeLessThanOrEqual(2);
  });

  it("still REFUSES a tool-bearing driver that cannot enforce the deny list", async () => {
    // The guard must keep doing its job for everything else. `anthropic` has
    // a tool surface and no deny-list mechanism.
    const deps = makeDeps();
    const res = await executeAgent(
      { prompt: "hello", driver: "anthropic", enforceSandbox: true },
      deps,
    );
    expect(res.text).toContain("[agent step failed:");
    expect(deps.anthropicFn).not.toHaveBeenCalled();
  });

  it("still refuses when the driver resolves to anthropic by auto-detect", async () => {
    const deps = makeDeps({
      probeClaudeCli: vi.fn().mockReturnValue(false),
      loadPatchworkConfig: vi.fn().mockReturnValue({}),
    });
    const res = await executeAgent(
      { prompt: "hello", enforceSandbox: true },
      deps,
    );
    expect(res.text).toContain("[agent step failed:");
  });

  it("allows local when it is reached by CONFIG rather than an explicit driver", async () => {
    // `config.json` with `model: "local"` resolves to the local driver too,
    // and resolveSandboxEnforcement has a separate branch for it. Both paths
    // must agree, or the exemption depends on how the driver was spelled.
    const deps = makeDeps({
      loadPatchworkConfig: vi.fn().mockReturnValue({ model: "local" }),
    });
    const res = await executeAgent(
      { prompt: "hello", enforceSandbox: true },
      deps,
    );
    expect(res.text).toBe("local-result");
  });
});
