/**
 * The behavioural half of §5's acceptance criteria — the ones that live in the
 * DOM rather than the stylesheet.
 *
 *   A3  no information conveyed by colour alone (every state has a text label)
 *   A5  fully keyboard operable
 *   A6  every button names its action ("Yes, go ahead", never "Yes")
 *   A7  state changes announced through a polite live region
 *   A11 every destructive action is undoable, and the undo does not time out
 *
 * Plus the rule that is not in the list but is easiest to break: no
 * hover-only affordances. Every control is in the document from the start.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ButlerPage from "../page";

const FACT = {
  seq: 1,
  subject: "user",
  predicate: "diet.avoid",
  object: "shellfish",
  recordedAt: 1_786_000_000_000,
  trust: 1,
  provenance: { channel: "user_chat", validated: false },
};

const GUESS = {
  seq: 2,
  subject: "user",
  predicate: "coffee",
  object: "flat white",
  recordedAt: 1_786_000_000_000,
  trust: 0.5,
  provenance: { channel: "connector", source: "gmail", validated: false },
};

const PERMISSION = {
  id: "p1",
  grantedAt: 1_786_000_000_000,
  grantedBy: null,
  scope: { domains: ["tasks"] },
  note: "small errands",
  active: true,
};

const EXERCISE = {
  permissionId: "p1",
  at: 1_786_000_000_000,
  toolName: "githubCreateIssue",
  classKey: "issue:compensable:high",
  recipeName: "butler-errand",
};

const ASK = {
  callId: "c1",
  toolName: "gitPush",
  tier: "high" as const,
  requestedAt: 1_786_000_000_000,
  summary: "Push the release branch",
};

/** Route each endpoint to a canned body; record what was sent. */
function mockBridge(over: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; method: string }> = [];
  const bodies: Record<string, unknown> = {
    "/butler/facts": { ok: true, facts: [FACT] },
    "/butler/quarantine": { ok: true, facts: [GUESS] },
    "/butler/permissions/exercises": { ok: true, exercises: [EXERCISE] },
    "/butler/permissions": { ok: true, permissions: [PERMISSION] },
    // GET /approvals returns a BARE ARRAY (src/approvalHttp.ts). This
    // fixture used to wrap it in `{pending: […]}`, which no server ever sent,
    // so the test passed while the page read `.pending` off an array and
    // rendered "Nothing right now." forever.
    "/approvals": [ASK],
    ...over,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: { method?: string }) => {
      calls.push({ url, method: init?.method ?? "GET" });
      // Longest match first so `/permissions/exercises` is not eaten by
      // `/permissions`.
      const key = Object.keys(bodies)
        .sort((a, b) => b.length - a.length)
        .find((k) => url.includes(k));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(key ? bodies[key] : {}),
      });
    }),
  );
  return calls;
}

beforeEach(() => {
  mockBridge();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("A6 — every button names its action", () => {
  it("no button is a bare Yes / No / OK", async () => {
    render(<ButlerPage />);
    await screen.findByText("Push the release branch");

    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      const name = (b.textContent ?? "").trim();
      // A screen-reader user tabbing a list of "OK" buttons has no idea which
      // one they are on.
      expect(name).not.toMatch(/^(yes|no|ok|cancel|confirm|delete)$/i);
      // Long enough to be a sentence fragment, not a token.
      expect(name.split(/\s+/).length).toBeGreaterThanOrEqual(2);
    }
  });

  it("the two answers to a question say what each one does", async () => {
    render(<ButlerPage />);
    expect(await screen.findByRole("button", { name: /yes, go ahead/i })).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: /no, leave it alone/i }),
    ).toBeTruthy();
  });
});

describe("A3 — no meaning carried by colour alone", () => {
  it("states where a fact came from in words", async () => {
    render(<ButlerPage />);
    expect(await screen.findByText(/You told me this/)).toBeTruthy();
    // The guess says so, and says it has not been acted on.
    expect(await screen.findByText(/I read this in your gmail/)).toBeTruthy();
    expect(screen.getAllByText(/have not acted on it/i).length).toBeGreaterThan(
      0,
    );
  });

  it("states whether a permission is live in words, not styling", async () => {
    render(<ButlerPage />);
    expect(await screen.findByText(/In force since/)).toBeTruthy();
  });

  it("says the irreversible promise out loud", async () => {
    render(<ButlerPage />);
    expect(
      await screen.findByText(/never do something you cannot undo/i),
    ).toBeTruthy();
  });
});

describe("A7 — state changes are announced politely", () => {
  it("has exactly one polite live region, present before anything happens", async () => {
    const { container } = render(<ButlerPage />);
    const regions = container.querySelectorAll('[aria-live="polite"]');
    // A live region added at the same moment as its message is often missed by
    // screen readers — it has to be in the DOM up front.
    expect(regions).toHaveLength(1);
    expect(container.querySelectorAll('[aria-live="assertive"]')).toHaveLength(
      0,
    );
  });

  it("announces the result of answering a question", async () => {
    const { container } = render(<ButlerPage />);
    fireEvent.click(await screen.findByRole("button", { name: /yes, go ahead/i }));
    await waitFor(() =>
      expect(
        container.querySelector('[aria-live="polite"]')?.textContent,
      ).toMatch(/I will go ahead/),
    );
  });

  it("announces a removal", async () => {
    const { container } = render(<ButlerPage />);
    fireEvent.click(
      await screen.findByRole("button", { name: /forget this about me/i }),
    );
    await waitFor(() =>
      expect(
        container.querySelector('[aria-live="polite"]')?.textContent,
      ).toMatch(/Removed/),
    );
  });
});

describe("A11 — destructive actions are undoable, and the undo does not time out", () => {
  it("offers an undo after a removal, and it survives the passage of time", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<ButlerPage />);
      fireEvent.click(
        await screen.findByRole("button", { name: /forget this about me/i }),
      );
      const undo = await screen.findByRole("button", { name: /undo that/i });
      expect(undo).toBeTruthy();

      // An hour later it is still there. A disappearing undo is precisely how
      // this product would fail a user who needed a moment to decide.
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(screen.getByRole("button", { name: /undo that/i })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("undoing a removal puts the fact back", async () => {
    const calls = mockBridge();
    render(<ButlerPage />);
    fireEvent.click(
      await screen.findByRole("button", { name: /forget this about me/i }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /undo that/i }));

    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.method === "POST" && c.url.includes("/butler/facts"),
        ),
      ).toBe(true),
    );
  });

  it("offers an undo after taking back a permission", async () => {
    render(<ButlerPage />);
    fireEvent.click(
      await screen.findByRole("button", { name: /take this back/i }),
    );
    expect(await screen.findByRole("button", { name: /undo that/i })).toBeTruthy();
  });
});

describe("A5 — keyboard operable, and nothing is hover-only", () => {
  it("every control is a real button in the document from the start", async () => {
    const { container } = render(<ButlerPage />);
    await screen.findByText("Push the release branch");

    // No div-with-onClick: a div is not focusable and not activated by Enter.
    const clickable = container.querySelectorAll("[onclick]");
    expect(clickable).toHaveLength(0);

    for (const b of screen.getAllByRole("button")) {
      // A negative tabindex would take it out of the tab order.
      const ti = b.getAttribute("tabindex");
      expect(ti === null || Number(ti) >= 0).toBe(true);
      expect(b.hasAttribute("disabled")).toBe(false);
    }
  });

  it("activates by keyboard, not just by pointer", async () => {
    const calls = mockBridge();
    render(<ButlerPage />);
    const yes = await screen.findByRole("button", { name: /yes, go ahead/i });
    // A native <button> fires click on Enter/Space; asserting the element type
    // is what actually guarantees that, so check it rather than simulating a
    // behaviour jsdom provides for free.
    expect(yes.tagName).toBe("BUTTON");
    expect(yes.getAttribute("type")).toBe("button");
    fireEvent.click(yes);
    await waitFor(() =>
      expect(
        // The bridge routes /approve/<id>; there is no /approvals/ prefix on
        // the decision route. This asserted the URL the page used to send,
        // which 404'd.
        calls.some((c) => c.url.includes("/approve/")),
      ).toBe(
        true,
      ),
    );
  });
});

describe("honesty when the bridge is unreachable", () => {
  it("says it could not reach the bridge, not that it knows nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))),
    );
    render(<ButlerPage />);
    // "Butler knows nothing about you" would be a lie the reader believes.
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(
      screen.getByText(/not the same as knowing nothing about you/i),
    ).toBeTruthy();
  });

  it("says so for a 502 too — the failure the old code could not see", async () => {
    // The dashboard proxy answers a dead bridge with a 502 whose BODY is
    // valid JSON: {"error":"Bridge unreachable"}. `.then(r => r.json())`
    // resolved, the shape guards fell through to [], and the page rendered
    // "Nothing yet." about a bridge it never reached. Only a network-level
    // rejection (the test above) ever reached the catch — so the existing
    // test passed while this, the failure that actually happens in
    // production, went unnoticed.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 502,
          json: () => Promise.resolve({ error: "Bridge unreachable" }),
        }),
      ),
    );
    render(<ButlerPage />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not reach the bridge/i);
  });

  it("distinguishes 'I cannot check' from 'you have granted nothing'", async () => {
    // The bridge answers 501 when it has no permission store, with an
    // explicit comment that it must not read as "you have granted nothing".
    // The client used to flatten that to an empty list, defeating the
    // distinction the server went out of its way to make.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 501,
          json: () => Promise.resolve({ error: "not available" }),
        }),
      ),
    );
    render(<ButlerPage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/cannot check/i);
  });
});

describe("structure", () => {
  it("is a single column with sections in reading order", async () => {
    const { container } = render(<ButlerPage />);
    await screen.findByText("Push the release branch");
    const headings = Array.from(container.querySelectorAll("h2")).map((h) =>
      (h.textContent ?? "").trim(),
    );
    // DOM order IS reading order — the plan's §4 ordering, which a screen
    // reader and a keyboard user both follow literally.
    expect(headings).toEqual([
      "Something I need to ask you",
      "What I know about you",
      "Things I noticed but have not used",
      "What I did without asking",
      "What you have allowed",
    ]);
  });

  it("every section is labelled by its own heading", async () => {
    const { container } = render(<ButlerPage />);
    for (const s of container.querySelectorAll("section")) {
      const id = s.getAttribute("aria-labelledby");
      expect(id).toBeTruthy();
      expect(container.querySelector(`#${id}`)).toBeTruthy();
    }
  });
});
