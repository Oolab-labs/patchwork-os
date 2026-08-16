/**
 * `patchwork approve` / `patchwork reject`.
 *
 * The bug being fixed is not subtle: the dashboard copies `patchwork approve
 * <callId>` to the clipboard and the subcommand did not exist, so running it
 * printed `Unknown command: 'approve'. Did you mean: approvals?` — suggesting
 * an unrelated read-only KPI report.
 *
 * These drive `runApproveCommand` with injected transport and sinks. The
 * separate end-to-end check that the BINARY dispatches at all lives in
 * approve-dispatch.test.ts, because a unit test of this function passes
 * happily while `KNOWN_SUBCOMMANDS` still routes the real argv somewhere else.
 */

import { describe, expect, it, vi } from "vitest";
import { type ApproveDeps, runApproveCommand } from "../approve.js";

function harness(
  over: Partial<ApproveDeps> & { responses?: Record<string, Response> } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const codes: number[] = [];
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  const fetchFn = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init });
      const canned = over.responses?.[u];
      if (canned) return canned;
      return new Response(JSON.stringify({ decision: "allow" }), {
        status: 200,
      });
    },
  ) as unknown as typeof fetch;

  const deps: ApproveDeps = {
    findBridgeLock: () => ({ port: 3100, authToken: "tok" }),
    fetchFn,
    write: (s) => out.push(s),
    writeErr: (s) => err.push(s),
    exit: (c) => codes.push(c),
    isTTY: false,
    confirm: async () => true,
    ...over,
  };
  return { deps, out, err, codes, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe("patchwork approve / reject", () => {
  it("POSTs to /approve/:callId with the bridge Bearer token", async () => {
    const h = harness();
    await runApproveCommand("approve", ["call-123"], h.deps);

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.url).toBe("http://127.0.0.1:3100/approve/call-123");
    expect(h.calls[0]?.init?.method).toBe("POST");
    expect(
      (h.calls[0]?.init?.headers as Record<string, string>).Authorization,
    ).toBe("Bearer tok");
    expect(h.codes).toEqual([0]);
    expect(h.out.join("")).toContain("Approved call-123");
  });

  it("POSTs to /reject/:callId and carries --reason into the body", async () => {
    const h = harness({
      responses: {
        "http://127.0.0.1:3100/reject/call-9": json({ decision: "deny" }),
      },
    });
    await runApproveCommand(
      "reject",
      ["call-9", "--reason", "touches prod"],
      h.deps,
    );

    expect(h.calls[0]?.url).toBe("http://127.0.0.1:3100/reject/call-9");
    expect(JSON.parse(String(h.calls[0]?.init?.body))).toEqual({
      reason: "touches prod",
    });
    expect(h.codes).toEqual([0]);
  });

  it("does not mistake the --reason VALUE for the callId", async () => {
    // `reject --reason foo call-1` — a naive positional filter takes "foo".
    const h = harness({
      responses: {
        "http://127.0.0.1:3100/reject/call-1": json({ decision: "deny" }),
      },
    });
    await runApproveCommand("reject", ["--reason", "foo", "call-1"], h.deps);
    expect(h.calls[0]?.url).toBe("http://127.0.0.1:3100/reject/call-1");
  });

  it("reports an already-decided approval as such, not as a generic failure", async () => {
    const h = harness({
      responses: {
        "http://127.0.0.1:3100/approve/call-2": json(
          { error: "already_decided", decision: "deny", callId: "call-2" },
          409,
        ),
      },
    });
    await runApproveCommand("approve", ["call-2"], h.deps);

    // The operator's real question is "why did nothing happen", and the answer
    // is that somebody else decided it — not that the bridge is broken.
    expect(h.err.join("")).toContain("already decided");
    expect(h.err.join("")).toContain("deny");
    expect(h.codes).toEqual([1]);
  });

  it("reports an unknown callId distinctly from a transport failure", async () => {
    const h = harness({
      responses: {
        "http://127.0.0.1:3100/approve/call-3": json(
          { error: "unknown callId" },
          404,
        ),
      },
    });
    await runApproveCommand("approve", ["call-3"], h.deps);
    expect(h.err.join("")).toContain("not pending");
    expect(h.codes).toEqual([1]);
  });

  it("refuses a callId that cannot match the route, without calling the bridge", async () => {
    const h = harness();
    await runApproveCommand("approve", ["../etc/passwd"], h.deps);
    // The route regex would 404 this; saying "not a callId" names the real
    // problem instead of implying the approval vanished.
    expect(h.err.join("")).toContain("is not a callId");
    expect(h.calls).toHaveLength(0);
    expect(h.codes).toEqual([1]);
  });

  it("explains that no bridge is running rather than failing to connect", async () => {
    const h = harness({ findBridgeLock: () => null });
    await runApproveCommand("approve", ["call-4"], h.deps);
    expect(h.err.join("")).toContain("no running bridge");
    expect(h.calls).toHaveLength(0);
    expect(h.codes).toEqual([1]);
  });

  it("prints usage when no callId is given", async () => {
    const h = harness();
    await runApproveCommand("approve", [], h.deps);
    expect(h.err.join("")).toContain("usage: patchwork approve <callId>");
    expect(h.codes).toEqual([1]);
  });

  describe("--edit", () => {
    it("says plainly that parameters cannot be modified", async () => {
      const h = harness({
        isTTY: true,
        responses: {
          "http://127.0.0.1:3100/approvals": json([
            {
              callId: "call-5",
              toolName: "git.push",
              params: { branch: "main" },
            },
          ]),
        },
      });
      await runApproveCommand("approve", ["call-5", "--edit"], h.deps);

      // The whole point: --edit must NOT imply a successful edit. An operator
      // who believes they changed the params would approve the original.
      expect(h.err.join("")).toContain("cannot modify parameters");
      expect(h.codes).toEqual([0]);
    });

    it("still approves after the notice — the copied command must work", async () => {
      const h = harness({
        isTTY: true,
        responses: {
          "http://127.0.0.1:3100/approvals": json([
            { callId: "call-6", toolName: "git.push" },
          ]),
        },
      });
      await runApproveCommand("approve", ["call-6", "--edit"], h.deps);
      expect(h.calls.some((c) => c.url.endsWith("/approve/call-6"))).toBe(true);
    });
  });

  describe("--review", () => {
    it("shows the queued action and approves on confirmation", async () => {
      const confirm = vi.fn(async () => true);
      const h = harness({
        isTTY: true,
        confirm,
        responses: {
          "http://127.0.0.1:3100/approvals": json([
            {
              callId: "call-7",
              toolName: "git.push",
              tier: "high",
              params: { branch: "main" },
            },
          ]),
        },
      });
      await runApproveCommand("approve", ["call-7", "--review"], h.deps);

      const printed = h.out.join("");
      expect(printed).toContain("git.push");
      expect(printed).toContain("high");
      expect(printed).toContain("branch");
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(h.calls.some((c) => c.url.endsWith("/approve/call-7"))).toBe(true);
    });

    it("sends NOTHING when the operator declines", async () => {
      const h = harness({
        isTTY: true,
        confirm: async () => false,
        responses: {
          "http://127.0.0.1:3100/approvals": json([
            { callId: "call-8", toolName: "git.push" },
          ]),
        },
      });
      await runApproveCommand("approve", ["call-8", "--review"], h.deps);

      // The decisive assertion: a declined review must not reach the bridge.
      expect(h.calls.some((c) => c.url.includes("/approve/"))).toBe(false);
      expect(h.out.join("")).toContain("Cancelled");
      expect(h.codes).toEqual([0]);
    });

    it("refuses to assume consent when stdin is not a terminal", async () => {
      const h = harness({
        isTTY: false,
        responses: {
          "http://127.0.0.1:3100/approvals": json([
            { callId: "call-10", toolName: "git.push" },
          ]),
        },
      });
      await runApproveCommand("approve", ["call-10", "--review"], h.deps);

      // Same discipline as `members set-password`: a confirmation that cannot
      // be given must never be inferred.
      expect(h.err.join("")).toContain("interactive terminal");
      expect(h.calls.some((c) => c.url.includes("/approve/"))).toBe(false);
      expect(h.codes).toEqual([1]);
    });

    it("stops when the callId is not actually pending", async () => {
      const h = harness({
        isTTY: true,
        responses: { "http://127.0.0.1:3100/approvals": json([]) },
      });
      await runApproveCommand("approve", ["call-11", "--review"], h.deps);
      expect(h.err.join("")).toContain("not in the pending list");
      expect(h.calls.some((c) => c.url.includes("/approve/"))).toBe(false);
      expect(h.codes).toEqual([1]);
    });
  });
});
