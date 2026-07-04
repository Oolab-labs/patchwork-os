/**
 * Smoke test for the Home "Terminal (dark)" deck (app/page.tsx).
 *
 * Prior to this PR, app/page.tsx had zero test coverage (per the redesign
 * plan's risk register). Covers:
 *   - the deck renders its 7 panes + statusline on a healthy bridge
 *   - one endpoint 500ing shows an inline error row in that pane only,
 *     the rest of the deck still renders (fail-soft requirement)
 *   - the live clock renders "—" before the first client tick (SSR-safe
 *     placeholder) then updates after the 1s interval fires
 *   - pane focus responds to number-key shortcuts (0-6)
 */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HomePage from "@/app/page";

const originalFetch = global.fetch;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Route table for the mocked fetch — keyed by a substring match against
 *  the request URL, since apiPath() may prefix a basePath. */
function mockFetchRoutes(routes: Record<string, () => Response>) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [key, make] of Object.entries(routes)) {
      if (url.includes(key)) return make();
    }
    return jsonResponse({}, 404);
  }) as unknown as typeof fetch;
}

/** Sets a controlled <input>'s value via the native setter (so React's
 *  onChange fires) then dispatches "input" — plain `.value =` + a synthetic
 *  Event bypasses React's value tracker and the component's state never
 *  updates, silently no-opping the "type + submit" flow in tests. */
function typeIntoInput(input: HTMLInputElement, value: string) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  nativeInputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const HEALTHY_ROUTES: Record<string, () => Response> = {
  "/api/bridge/health": () =>
    jsonResponse({
      status: "ok",
      uptimeMs: 60_000,
      connections: 1,
      extensionConnected: true,
      extensionVersion: "1.0.0",
      activeSessions: 2,
    }),
  "/api/bridge/status": () =>
    jsonResponse({ ok: true, port: 3101, uptimeMs: 60_000, activeSessions: 2 }),
  "/api/bridge/kill-switch": () => jsonResponse({ engaged: false, locked: false }),
  "/api/bridge/approvals": () => jsonResponse([]),
  "/api/bridge/recipes": () =>
    jsonResponse({
      recipes: [
        { name: "daily-brief", enabled: true, schedule: "0 7 * * *" },
        { name: "paused-thing", enabled: false, schedule: "0 9 * * *" },
      ],
    }),
  "/api/bridge/activity": () => jsonResponse({ events: [] }),
  "/api/bridge/runs/halt-summary": () => jsonResponse({ total: 0 }),
  "/api/bridge/runs": () => jsonResponse({ runs: [] }),
  "/api/bridge/workers/shadow": () =>
    jsonResponse({ workers: [], runsScanned: 0, decisionsScanned: 0 }),
  "/api/bridge/gate/decisions": () => jsonResponse({ decisions: [] }),
  "/api/inbox": () => jsonResponse({ items: [] }),
};

const SAMPLE_GATE_DECISION = {
  seq: 42,
  decidedAt: Date.UTC(2026, 5, 3, 7, 43),
  workerId: "test-guardian",
  toolName: "githubCreateIssue",
  classKey: "issue:compensable:high",
  action: "gate",
  owned: true,
  earnedLevel: 1,
  autonomyCeiling: 3,
  effectiveLevel: 1,
  reason: "earned trust (L1) below the compensable-action threshold (L2)",
  recipeName: "triage-failing-tests",
  gatePolicyVersion: "v1",
};

describe("<HomePage/> — Terminal deck", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.localStorage.clear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it("renders the statusline + all 7 panes on a healthy bridge", async () => {
    mockFetchRoutes(HEALTHY_ROUTES);
    render(<HomePage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    for (const label of [
      "attention",
      "tail",
      "fleet",
      "next",
      "workers",
      "vitals",
      "inbox",
    ]) {
      expect(screen.getByRole("region", { name: label })).toBeTruthy();
    }
    // Statusline segments.
    expect(screen.getByText(/patchwork · local:/)).toBeTruthy();
  });

  it("fails soft: one endpoint 500ing still lets the rest of the deck render", async () => {
    mockFetchRoutes({
      ...HEALTHY_ROUTES,
      "/api/bridge/workers/shadow": () => jsonResponse({ error: "boom" }, 500),
    });
    render(<HomePage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    // Workers pane shows an inline error, not a crash.
    const workersPane = screen.getByRole("region", { name: "workers" });
    expect(workersPane.textContent).toMatch(/unavailable/i);

    // Other panes still rendered fine.
    expect(screen.getByRole("region", { name: "fleet" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "vitals" })).toBeTruthy();
  });

  it("renders the SSR clock placeholder then ticks after mount", async () => {
    mockFetchRoutes(HEALTHY_ROUTES);
    render(<HomePage />);

    // Clock starts as the em-dash placeholder before the first effect tick.
    // (React may flush the effect synchronously in the test renderer, so
    // just assert it eventually shows a real HH:MM:SS instead of asserting
    // the very first paint frame.)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });

    await waitFor(() => {
      const statusline = screen.getByRole("status", { name: "Bridge status" });
      expect(statusline.textContent).toMatch(/\d{2}:\d{2}:\d{2}/);
    });
  });

  it("moves pane focus on number-key shortcuts", async () => {
    mockFetchRoutes(HEALTHY_ROUTES);
    render(<HomePage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    const fleetPane = screen.getByRole("region", { name: "fleet" });
    expect(fleetPane.className).not.toMatch(/td-pane-active/);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "2" }));
    });

    await waitFor(() => {
      expect(fleetPane.className).toMatch(/td-pane-active/);
    });
  });

  it("renders gate-activity entries in the workers pane (Decision Record feed)", async () => {
    mockFetchRoutes({
      ...HEALTHY_ROUTES,
      "/api/bridge/gate/decisions": () =>
        jsonResponse({ decisions: [SAMPLE_GATE_DECISION] }),
    });
    render(<HomePage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    const workersPane = screen.getByRole("region", { name: "workers" });
    expect(workersPane.textContent).toMatch(/GATE/);
    expect(workersPane.textContent).toMatch(/test-guardian/);
    expect(workersPane.textContent).toMatch(/issue:compensable:high/);
    // effectiveLevel 1 → "asks first" per the shared level-phrase vocabulary.
    expect(workersPane.textContent).toMatch(/asks first/);
  });

  it("expands a gate-activity row to show the plain-English explain rendering", async () => {
    mockFetchRoutes({
      ...HEALTHY_ROUTES,
      "/api/bridge/gate/decisions": () =>
        jsonResponse({ decisions: [SAMPLE_GATE_DECISION] }),
    });
    render(<HomePage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    const row = screen.getByRole("button", { expanded: false });
    await act(async () => {
      row.click();
    });

    await waitFor(() => {
      expect(row.getAttribute("aria-expanded")).toBe("true");
    });
    const workersPane = screen.getByRole("region", { name: "workers" });
    expect(workersPane.textContent).toMatch(/earned L1/);
    expect(workersPane.textContent).toMatch(/autonomy ceiling L3/);
    expect(workersPane.textContent).toMatch(
      /earned trust \(L1\) below the compensable-action threshold \(L2\)/,
    );
  });

  it("statusline clock flips to 'data as of … reconnecting' when the deck's own poll goes stale, and clears on recovery", async () => {
    // Bug Fix Protocol: this test must fail before the statusline is wired
    // to the staleness registry — the deck's primary poll (tracked via
    // useManualPollStaleness) already existed, but nothing in the
    // statusline read `getStaleFetchSummary()`, so a stalled bridge never
    // changed what the clock segment showed.
    let hang = false;
    mockFetchRoutes({
      ...HEALTHY_ROUTES,
      "/api/bridge/recipes": () => {
        if (hang) return new Promise(() => {}) as unknown as Response;
        return jsonResponse({ recipes: [] });
      },
    });
    render(<HomePage />);

    // First tick succeeds — registers a lastSuccessAt.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    const statusline = screen.getByRole("status", { name: "Bridge status" });
    expect(statusline.textContent).not.toMatch(/reconnecting/);

    // Now every subsequent poll hangs forever — 3x the 5000ms interval
    // (plus the 1s staleness re-check cadence) must flip the flag.
    hang = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });

    await waitFor(() => {
      expect(statusline.textContent).toMatch(/data as of .* reconnecting/i);
    });

    // Recovery: next successful poll clears it back to the live clock.
    hang = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });

    await waitFor(() => {
      expect(statusline.textContent).not.toMatch(/reconnecting/i);
    });
  });

  it("0:attention shows a Stop control for a live run and cancels it via the shared dialog", async () => {
    const cancelMock = vi.fn().mockResolvedValue(
      jsonResponse({ cancelled: true, seq: 501 }),
    );
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/bridge/runs/501/cancel")) return cancelMock();
      for (const [key, make] of Object.entries({
        ...HEALTHY_ROUTES,
        "/api/bridge/runs": () =>
          jsonResponse({
            runs: [
              {
                seq: 501,
                recipe: "daily-brief",
                recipeName: "daily-brief",
                startedAt: Date.now() - 5000,
                status: "running",
              },
            ],
          }),
      })) {
        if (url.includes(key)) return make();
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    render(<HomePage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    const attentionPane = screen.getByRole("region", { name: "attention" });
    expect(attentionPane.textContent).toMatch(/running/i);
    expect(attentionPane.textContent).toMatch(/daily brief/i);

    const stopBtn = within(attentionPane).getByTitle("Stop this run of daily-brief");
    await act(async () => {
      stopBtn.click();
    });

    // Confirm dialog gates the actual cancel call.
    const confirmBtn = await screen.findByText("Stop run");
    await act(async () => {
      confirmBtn.click();
    });

    await waitFor(() => {
      expect(cancelMock).toHaveBeenCalledTimes(1);
    });

    // Optimistic update: the live-run row disappears once cancelled.
    await waitFor(() => {
      expect(within(attentionPane).queryByTitle("Stop this run of daily-brief")).toBeNull();
    });
  });

  it("1:tail shows a Stop control on the row for an in-progress run matched by recipeName", async () => {
    const cancelMock = vi.fn().mockResolvedValue(
      jsonResponse({ cancelled: true, seq: 777 }),
    );
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/bridge/runs/777/cancel")) return cancelMock();
      for (const [key, make] of Object.entries({
        ...HEALTHY_ROUTES,
        "/api/bridge/runs": () =>
          jsonResponse({
            runs: [
              {
                seq: 777,
                recipe: "morning-brief",
                recipeName: "morning-brief",
                startedAt: Date.now() - 2000,
                status: "running",
              },
            ],
          }),
        "/api/bridge/activity": () =>
          jsonResponse({
            events: [
              {
                kind: "lifecycle",
                event: "recipe_step_started",
                at: Date.now() - 1000,
                metadata: { recipeName: "morning-brief" },
              },
            ],
          }),
      })) {
        if (url.includes(key)) return make();
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    render(<HomePage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    const tailPane = screen.getByRole("region", { name: "tail" });
    const stopBtn = within(tailPane).getByTitle("Stop this run of morning-brief");
    await act(async () => {
      stopBtn.click();
    });

    const confirmBtn = await screen.findByText("Stop run");
    await act(async () => {
      confirmBtn.click();
    });

    await waitFor(() => {
      expect(cancelMock).toHaveBeenCalledTimes(1);
    });
  });

  it("fails soft when /gate/decisions is empty or errors", async () => {
    mockFetchRoutes({
      ...HEALTHY_ROUTES,
      "/api/bridge/gate/decisions": () => jsonResponse({ decisions: [] }),
    });
    const { unmount } = render(<HomePage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    let workersPane = screen.getByRole("region", { name: "workers" });
    expect(workersPane.textContent).toMatch(/no gate decisions yet/i);
    unmount();

    mockFetchRoutes({
      ...HEALTHY_ROUTES,
      "/api/bridge/gate/decisions": () => jsonResponse({ error: "boom" }, 500),
    });
    render(<HomePage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    workersPane = screen.getByRole("region", { name: "workers" });
    expect(workersPane.textContent).toMatch(/gate activity unavailable/i);
    // Rest of the pane (worker trust rows) still renders — fail-soft.
    expect(workersPane.textContent).toMatch(/no worker activity yet/i);
  });

  // --------------------------------------------------------------------
  // Phase 4: halt-age escalation, mute fingerprinting, footer hint, and
  // the folded-in-from-/today worker-verdict confirm queue + team rollup.
  // --------------------------------------------------------------------

  it("escalates a halt's visual treatment once it's been open a long time (halt-age escalation)", async () => {
    mockFetchRoutes({
      ...HEALTHY_ROUTES,
      "/api/bridge/runs": () =>
        jsonResponse({
          runs: [
            {
              seq: 900,
              recipe: "stale-halt",
              recipeName: "stale-halt",
              startedAt: Date.now() - 7 * 60 * 60 * 1000,
              status: "error",
            },
          ],
        }),
      "/api/bridge/runs/halt-summary": () => jsonResponse({ total: 1 }),
    });
    render(<HomePage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    const attentionPane = screen.getByRole("region", { name: "attention" });
    expect(attentionPane.textContent).toMatch(/needs attention/i);
    expect(attentionPane.querySelector(".td-pill-critical")).toBeTruthy();
  });

  it("does not escalate a fresh halt (<1h old)", async () => {
    mockFetchRoutes({
      ...HEALTHY_ROUTES,
      "/api/bridge/runs": () =>
        jsonResponse({
          runs: [
            {
              seq: 901,
              recipe: "fresh-halt",
              recipeName: "fresh-halt",
              startedAt: Date.now() - 5 * 60 * 1000,
              status: "error",
            },
          ],
        }),
      "/api/bridge/runs/halt-summary": () => jsonResponse({ total: 1 }),
    });
    render(<HomePage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    const attentionPane = screen.getByRole("region", { name: "attention" });
    expect(attentionPane.textContent).not.toMatch(/needs attention/i);
    expect(attentionPane.querySelector(".td-pill-critical")).toBeNull();
  });

  it("mute suppresses the muted halt, but a genuinely new/different halt bypasses the mute (fingerprint fix)", async () => {
    let runsPayload = {
      runs: [
        {
          seq: 910,
          recipe: "recurring-thing",
          recipeName: "recurring-thing",
          startedAt: Date.now() - 10 * 60 * 1000,
          status: "error",
          haltReason: "known flaky connector",
        },
      ],
    };
    mockFetchRoutes({
      ...HEALTHY_ROUTES,
      "/api/bridge/runs": () => jsonResponse(runsPayload),
      "/api/bridge/runs/halt-summary": () => jsonResponse({ total: 1 }),
    });
    render(<HomePage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    const attentionPane = screen.getByRole("region", { name: "attention" });
    const muteBtn = within(attentionPane).getByText("Mute 24h");
    await act(async () => {
      muteBtn.click();
    });

    await waitFor(() => {
      expect(attentionPane.textContent).toMatch(/Muted until/);
    });

    // A brand-new, different halt (different seq) shows up on the next poll
    // — the mute must NOT hide it, even though we're still inside the 24h
    // window from the click above.
    runsPayload = {
      runs: [
        {
          seq: 911,
          recipe: "unrelated-thing",
          recipeName: "unrelated-thing",
          startedAt: Date.now() - 60 * 1000,
          status: "error",
          haltReason: "brand new problem",
        },
      ],
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    await waitFor(() => {
      expect(attentionPane.textContent).not.toMatch(/Muted until/);
      expect(attentionPane.textContent).toMatch(/Unrelated Thing/i);
    });
  });

  it("renders a footer hint for the pane keyboard shortcuts", async () => {
    mockFetchRoutes(HEALTHY_ROUTES);
    const { container } = render(<HomePage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    const footer = container.querySelector(".td-footer");
    expect(footer).toBeTruthy();
    expect(footer?.textContent).toMatch(/0.{1,2}6 focus a pane/);
  });

  it("0:attention surfaces a pending worker-verdict confirmation and clears it via Confirm/Reject (folded from /today)", async () => {
    const outcomeMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/bridge/outcomes") && !url.includes("/pending")) {
        return outcomeMock(init);
      }
      for (const [key, make] of Object.entries({
        ...HEALTHY_ROUTES,
        "/api/bridge/outcomes/pending": () =>
          jsonResponse({
            pending: [
              {
                issueUrl: "https://github.com/o/r/issues/1",
                recipeName: "triage-failing-tests",
                workerId: "test-guardian",
                workerName: "Test Guardian",
                filedAt: Date.now() - 60_000,
                classKey: "issue:compensable:high",
                title: "Login test failing on main",
              },
            ],
          }),
      })) {
        if (url.includes(key)) return make();
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    render(<HomePage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    const attentionPane = screen.getByRole("region", { name: "attention" });
    expect(attentionPane.textContent).toMatch(/worker verdict/i);
    expect(attentionPane.textContent).toMatch(/Login test failing on main/);

    const confirmBtn = within(attentionPane).getByText("Looks real");
    await act(async () => {
      confirmBtn.click();
    });

    await waitFor(() => {
      expect(outcomeMock).toHaveBeenCalledTimes(1);
    });
    const body = JSON.parse((outcomeMock.mock.calls[0]?.[0] as RequestInit)?.body as string);
    expect(body).toMatchObject({
      issueUrl: "https://github.com/o/r/issues/1",
      disposition: "confirmed",
    });
  });

  it("shows the 'N of 3 done' morning-habit strip between the statusline and the pane grid, and 'You're clear' once all 3 are done", async () => {
    mockFetchRoutes(HEALTHY_ROUTES);
    const { container } = render(<HomePage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    const strip = container.querySelector(".td-today-strip");
    expect(strip).toBeTruthy();
    // Placed between the statusline and the grid, not inside either.
    expect(strip?.previousElementSibling).toHaveClass("td-statusline");
    expect(strip?.nextElementSibling).toHaveClass("td-grid");
    // HEALTHY_ROUTES has no pending outcomes, no workers, no inbox items —
    // all 3 sections ("decisions", "team", "brief") read as done.
    expect(strip?.textContent).toMatch(/You're clear/);
  });

  it("today strip shows 'N of 3 done' when a worker-verdict confirmation is still pending", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      for (const [key, make] of Object.entries({
        ...HEALTHY_ROUTES,
        "/api/bridge/outcomes/pending": () =>
          jsonResponse({
            pending: [
              {
                issueUrl: "https://github.com/o/r/issues/1",
                recipeName: "triage-failing-tests",
                workerId: "test-guardian",
                workerName: "Test Guardian",
                filedAt: Date.now() - 60_000,
                classKey: "issue:compensable:high",
                title: "Login test failing on main",
              },
            ],
          }),
      })) {
        if (url.includes(key)) return make();
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    const { container } = render(<HomePage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    const strip = container.querySelector(".td-today-strip");
    expect(strip?.textContent).toMatch(/2 of 3 done/);
  });

  it("4:workers header shows a promote/demote rollup (folded from /today's 'glance at the team')", async () => {
    mockFetchRoutes({
      ...HEALTHY_ROUTES,
      "/api/bridge/workers/shadow": () =>
        jsonResponse({
          workers: [
            {
              workerId: "w1",
              name: "Dependency Bump",
              autonomyCeiling: 1,
              board: [
                {
                  classKey: "vcs-remote:compensable:medium",
                  level: 3,
                  observations: 20,
                  mean: 0.95,
                  owned: true,
                },
              ],
              events: [],
              compared: 10,
              agreed: 10,
              divergences: [],
            },
          ],
          runsScanned: 0,
          decisionsScanned: 0,
        }),
    });
    render(<HomePage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    const workersPane = screen.getByRole("region", { name: "workers" });
    expect(workersPane.textContent).toMatch(/ready to promote/i);
  });

  // --------------------------------------------------------------------
  // 7:copilot — Tier 1 lever-action chat pane.
  // --------------------------------------------------------------------

  it("renders the copilot pane with an empty-state hint", async () => {
    mockFetchRoutes(HEALTHY_ROUTES);
    render(<HomePage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(screen.getByText(/ask or act: pause · run · why did X halt/)).toBeTruthy();
  });

  it("sends a message, shows the bot reply, and proposes a pause action card", async () => {
    const copilotMock = vi.fn().mockResolvedValue(
      jsonResponse({
        reply: 'Review the card below to disable "daily-brief".',
        action: { kind: "pause_recipe", recipeName: "daily-brief" },
      }),
    );
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/bridge/copilot/message")) return copilotMock(init);
      for (const [key, make] of Object.entries(HEALTHY_ROUTES)) {
        if (url.includes(key)) return make();
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    render(<HomePage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    const input = screen.getByLabelText("Copilot chat input");
    await act(async () => {
      input.dispatchEvent(new Event("focus"));
      typeIntoInput(input as HTMLInputElement, "pause daily-brief");
    });
    const form = input.closest("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(copilotMock).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse((copilotMock.mock.calls[0]?.[0] as RequestInit)?.body as string);
    expect(sentBody).toEqual({ text: "pause daily-brief" });

    await waitFor(() => {
      expect(screen.getByText(/Review the card below to disable/)).toBeTruthy();
    });
    expect(screen.getByText("Confirm")).toBeTruthy();
  });

  it("clicking Confirm on a pause_recipe card calls the SAME PATCH endpoint the recipes page uses, and marks the card done", async () => {
    const patchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/api/bridge/copilot/message")) {
        return jsonResponse({
          reply: 'Review the card below to disable "daily-brief".',
          action: { kind: "pause_recipe", recipeName: "daily-brief" },
        });
      }
      if (method === "PATCH" && url.includes("/api/bridge/recipes/daily-brief")) {
        return patchMock(init);
      }
      for (const [key, make] of Object.entries(HEALTHY_ROUTES)) {
        if (url.includes(key)) return make();
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    render(<HomePage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    const input = screen.getByLabelText("Copilot chat input");
    await act(async () => {
      typeIntoInput(input as HTMLInputElement, "pause daily-brief");
    });
    const form = input.closest("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await vi.advanceTimersByTimeAsync(50);
    });

    const confirmBtn = await screen.findByText("Confirm");
    await act(async () => {
      confirmBtn.click();
      await vi.advanceTimersByTimeAsync(50);
    });

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledTimes(1);
    });
    // Same shape useToggleRecipeEnabled sends — a raw endpoint bypass
    // would use a different method/body shape than this.
    const patchInit = patchMock.mock.calls[0]?.[0] as RequestInit;
    expect(patchInit.method).toBe("PATCH");
    expect(JSON.parse(patchInit.body as string)).toEqual({ enabled: false });

    await waitFor(() => {
      expect(screen.getByText("✓ done")).toBeTruthy();
    });
  });

  it("confirming an action records a Decision Record trace with source:copilot", async () => {
    const traceMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/api/bridge/copilot/message")) {
        return jsonResponse({
          reply: 'Review the card below to disable "daily-brief".',
          action: { kind: "pause_recipe", recipeName: "daily-brief" },
        });
      }
      if (method === "PATCH" && url.includes("/api/bridge/recipes/daily-brief")) {
        return jsonResponse({ ok: true });
      }
      if (method === "POST" && url.includes("/api/bridge/traces/decision")) {
        return traceMock(init);
      }
      for (const [key, make] of Object.entries(HEALTHY_ROUTES)) {
        if (url.includes(key)) return make();
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    render(<HomePage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    const input = screen.getByLabelText("Copilot chat input");
    await act(async () => {
      typeIntoInput(input as HTMLInputElement, "pause daily-brief");
    });
    const form = input.closest("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await vi.advanceTimersByTimeAsync(50);
    });

    const confirmBtn = await screen.findByText("Confirm");
    await act(async () => {
      confirmBtn.click();
      await vi.advanceTimersByTimeAsync(50);
    });

    await waitFor(() => {
      expect(traceMock).toHaveBeenCalledTimes(1);
    });
    const traceBody = JSON.parse((traceMock.mock.calls[0]?.[0] as RequestInit)?.body as string);
    expect(traceBody).toMatchObject({
      ref: "copilot:daily-brief",
      problem: "pause daily-brief",
      source: "copilot",
      tags: ["copilot", "pause_recipe"],
    });
    expect(traceBody.solution).toMatch(/daily-brief/);
  });

  it("Undo on a done pause_recipe card re-enables the recipe and records another trace", async () => {
    const patchCalls: unknown[] = [];
    const traceMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/api/bridge/copilot/message")) {
        return jsonResponse({
          reply: 'Review the card below to disable "daily-brief".',
          action: { kind: "pause_recipe", recipeName: "daily-brief" },
        });
      }
      if (method === "PATCH" && url.includes("/api/bridge/recipes/daily-brief")) {
        patchCalls.push(JSON.parse((init?.body as string) ?? "{}"));
        return jsonResponse({ ok: true });
      }
      if (method === "POST" && url.includes("/api/bridge/traces/decision")) {
        return traceMock(init);
      }
      for (const [key, make] of Object.entries(HEALTHY_ROUTES)) {
        if (url.includes(key)) return make();
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    render(<HomePage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    const input = screen.getByLabelText("Copilot chat input");
    await act(async () => {
      typeIntoInput(input as HTMLInputElement, "pause daily-brief");
    });
    const form = input.closest("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await vi.advanceTimersByTimeAsync(50);
    });
    const confirmBtn = await screen.findByText("Confirm");
    await act(async () => {
      confirmBtn.click();
      await vi.advanceTimersByTimeAsync(50);
    });
    await waitFor(() => expect(screen.getByText("✓ done")).toBeTruthy());

    const undoBtn = await screen.findByText("Undo");
    await act(async () => {
      undoBtn.click();
      await vi.advanceTimersByTimeAsync(50);
    });

    await waitFor(() => {
      expect(screen.getByText("↺ undone")).toBeTruthy();
    });
    expect(patchCalls).toHaveLength(2);
    expect(patchCalls[0]).toEqual({ enabled: false });
    expect(patchCalls[1]).toEqual({ enabled: true });
    await waitFor(() => {
      expect(traceMock).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByText("Undo")).toBeNull();
  });

  it("audit regression: a stale background poll landing right after Confirm does not clobber the optimistic state, so Undo still flips the right direction", async () => {
    // Simulates the exact race an audit found: the page's 5s poll always
    // returns the recipe as `enabled: true` here (as if fetched before the
    // PATCH ever landed, or the bridge is just slow to reflect it) — a
    // buggy implementation would let this stale snapshot overwrite the
    // optimistic `false` written by Confirm, so a subsequent Undo would
    // recompute its target off the clobbered `true` and PATCH
    // `{enabled: false}` again instead of `{enabled: true}`.
    const patchCalls: unknown[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/api/bridge/copilot/message")) {
        return jsonResponse({
          reply: 'Review the card below to disable "daily-brief".',
          action: { kind: "pause_recipe", recipeName: "daily-brief" },
        });
      }
      if (method === "PATCH" && url.includes("/api/bridge/recipes/daily-brief")) {
        patchCalls.push(JSON.parse((init?.body as string) ?? "{}"));
        return jsonResponse({ ok: true });
      }
      if (method === "POST" && url.includes("/api/bridge/traces/decision")) {
        return jsonResponse({ ok: true });
      }
      // Deliberately stale: the bridge "hasn't caught up" and keeps
      // reporting enabled:true even after the PATCH above succeeds.
      if (url.includes("/api/bridge/recipes")) {
        return jsonResponse({
          recipes: [{ name: "daily-brief", enabled: true, schedule: "0 7 * * *" }],
        });
      }
      for (const [key, make] of Object.entries(HEALTHY_ROUTES)) {
        if (url.includes(key)) return make();
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    render(<HomePage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    const input = screen.getByLabelText("Copilot chat input");
    await act(async () => {
      typeIntoInput(input as HTMLInputElement, "pause daily-brief");
    });
    const form = input.closest("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await vi.advanceTimersByTimeAsync(50);
    });
    const confirmBtn = await screen.findByText("Confirm");
    await act(async () => {
      confirmBtn.click();
      await vi.advanceTimersByTimeAsync(50);
    });
    await waitFor(() => expect(screen.getByText("✓ done")).toBeTruthy());
    expect(patchCalls).toEqual([{ enabled: false }]);

    // Let one stale background poll (5s cadence) land within the 8s grace
    // window — it would clobber `recipes` back to enabled:true in the
    // buggy version.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    const undoBtn = await screen.findByText("Undo");
    await act(async () => {
      undoBtn.click();
      await vi.advanceTimersByTimeAsync(50);
    });

    await waitFor(() => {
      expect(screen.getByText("↺ undone")).toBeTruthy();
    });
    // The critical assertion: Undo's PATCH must be the OPPOSITE of the
    // original Confirm's PATCH, proving the stale polls never clobbered
    // the locally-known post-Confirm state.
    expect(patchCalls).toEqual([{ enabled: false }, { enabled: true }]);
  });

  it("run_recipe action cards never show an Undo button once done", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/bridge/copilot/message")) {
        return jsonResponse({
          reply: 'Review the card below to run "daily-brief" now.',
          action: { kind: "run_recipe", recipeName: "daily-brief" },
        });
      }
      if (url.includes("/api/bridge/recipes/daily-brief/run")) {
        return jsonResponse({ ok: true, taskId: "abc123" });
      }
      for (const [key, make] of Object.entries(HEALTHY_ROUTES)) {
        if (url.includes(key)) return make();
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    render(<HomePage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    const input = screen.getByLabelText("Copilot chat input");
    await act(async () => {
      typeIntoInput(input as HTMLInputElement, "run daily-brief");
    });
    const form = input.closest("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await vi.advanceTimersByTimeAsync(50);
    });
    const confirmBtn = await screen.findByText("Confirm");
    await act(async () => {
      confirmBtn.click();
      await vi.advanceTimersByTimeAsync(50);
    });
    await waitFor(() => expect(screen.getByText("✓ done")).toBeTruthy());
    expect(screen.queryByText("Undo")).toBeNull();
  });

  it("Dismiss removes the action card without calling any endpoint", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/bridge/copilot/message")) {
        return jsonResponse({
          reply: 'Review the card below to run "daily-brief".',
          action: { kind: "run_recipe", recipeName: "daily-brief" },
        });
      }
      for (const [key, make] of Object.entries(HEALTHY_ROUTES)) {
        if (url.includes(key)) return make();
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    render(<HomePage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    const input = screen.getByLabelText("Copilot chat input");
    await act(async () => {
      typeIntoInput(input as HTMLInputElement, "run daily-brief");
    });
    const form = input.closest("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await vi.advanceTimersByTimeAsync(50);
    });

    const copilotPane = document.querySelector(".td-copilot") as HTMLElement;
    const dismissBtn = await within(copilotPane).findByRole("button", { name: "Dismiss" });
    await act(async () => {
      dismissBtn.click();
    });

    await waitFor(() => {
      expect(within(copilotPane).queryByRole("button", { name: "Confirm" })).toBeNull();
      expect(within(copilotPane).queryByRole("button", { name: "Dismiss" })).toBeNull();
    });
  });

  it("shows a fallback message and does not crash when the copilot endpoint is unreachable", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/bridge/copilot/message")) {
        return jsonResponse({ error: "boom" }, 500);
      }
      for (const [key, make] of Object.entries(HEALTHY_ROUTES)) {
        if (url.includes(key)) return make();
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    render(<HomePage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    const input = screen.getByLabelText("Copilot chat input");
    await act(async () => {
      typeIntoInput(input as HTMLInputElement, "pause daily-brief");
    });
    const form = input.closest("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await vi.advanceTimersByTimeAsync(50);
    });

    await waitFor(() => {
      expect(screen.getByText(/Couldn't reach the copilot endpoint/)).toBeTruthy();
    });
  });
});
