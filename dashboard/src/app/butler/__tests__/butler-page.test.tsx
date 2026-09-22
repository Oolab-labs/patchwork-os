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
      // DELETE /butler/facts/:seq answers with the tombstone, and its seq is
      // what the undo needs to call the restore route. The mock returned `{}`,
      // so a client reading the tombstone would silently offer no undo — the
      // fixture has to answer like the server or the test proves nothing.
      const isFactDelete =
        init?.method === "DELETE" && url.includes("/butler/facts/");
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            isFactDelete
              ? { ok: true, erased: false, tombstone: { seq: 99 } }
              : key
                ? bodies[key]
                : {},
          ),
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
        // Specifically the restore route. Asserting any POST to
        // /butler/facts passed against the old client, which re-created the
        // fact as `user_chat` and lost its provenance.
        calls.some(
          (c) => c.method === "POST" && c.url.includes("/butler/facts/99/restore"),
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

/** Every source healthy and empty — the genuine all-clear. */
/**
 * Undo offers now survive a reload, which means they survive a TEST unless it
 * says otherwise — and an offer left by a previous case appeared on the next
 * one's all-clear page as a third heading. Clearing here keeps each case
 * describing only what it set up.
 */
beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    // Storage is not available in every environment; nothing to clear.
  }
});

function stubAllEmpty() {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            String(url).includes("approvals")
              ? []
              : { facts: [], permissions: [], exercises: [] },
          ),
      }),
    ),
  );
}

/** One named endpoint fails; the rest answer normally and emptily. */
function stubWithFailure(fragment: string, status: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (String(url).includes(fragment)) {
        return Promise.resolve({
          ok: false,
          status,
          json: () => Promise.resolve({ error: "no" }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            String(url).includes("approvals")
              ? []
              : { facts: [], permissions: [], exercises: [] },
          ),
      });
    }),
  );
}

/** A 200 whose body parses but is not the shape the client expects. */
function stubMalformed(fragment: string, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            String(url).includes(fragment)
              ? body
              : String(url).includes("approvals")
                ? []
                : { facts: [], permissions: [], exercises: [] },
          ),
      }),
    ),
  );
}

describe("structure", () => {
  /**
   * This replaced an assertion listing five literal headings in one fixed
   * order. That test was not protecting the wording — its own comment said
   * "DOM order IS reading order", so the guarantee is that a screen-reader or
   * keyboard user meets an urgent decision before passive information. The
   * five headings were how that intent got frozen, and freezing it made the
   * information architecture unchangeable without failing a test that looked
   * like an accessibility test.
   *
   * The intent survives, expressed as outcomes. See
   * docs/butler-product-reset.md.
   */
  it("puts what needs a decision before anything passive", async () => {
    const { container } = render(<ButlerPage />);
    await screen.findByText("Push the release branch");
    const headings = Array.from(container.querySelectorAll("h2")).map((h) =>
      (h.textContent ?? "").trim(),
    );
    const ask = headings.findIndex((h) => /need to ask you/i.test(h));
    expect(ask).toBeGreaterThanOrEqual(0);
    // Everything else is reference material a reader may skip.
    for (const [i, h] of headings.entries()) {
      if (i === ask) continue;
      expect(i, `"${h}" precedes the decision`).toBeGreaterThan(ask);
    }
  });

  it("states what needs a decision before the page is scrolled", async () => {
    render(<ButlerPage />);
    // The headline answers the question the reader came with, in words, and
    // does not require reaching a section to find it.
    const status = await screen.findByText(
      /waiting for your decision|could not find out whether/i,
    );
    expect(status).toBeTruthy();
  });

  it("puts an unreadable source ahead of what it would undermine", async () => {
    // A reader who has taken in three sections must not discover afterwards
    // that a fourth was never consulted.
    //
    // The first version of this test never made a source fail and wrapped its
    // assertion in `if (unchecked >= 0)`, so it passed by the heading being
    // ABSENT — a guard that could not fail. One endpoint genuinely fails here.
    stubWithFailure("permissions", 501);
    const { container } = render(<ButlerPage />);
    const headings = () =>
      Array.from(container.querySelectorAll("h2")).map((h) =>
        (h.textContent ?? "").trim(),
      );
    await screen.findAllByText(/could not make sense|cannot check/i);

    const hs = headings();
    const unchecked = hs.findIndex((h) => /could not check/i.test(h));
    expect(unchecked, "the unavailable section must be rendered").toBeGreaterThanOrEqual(0);
    const allowed = hs.findIndex((h) => /you have allowed/i.test(h));
    expect(allowed).toBeGreaterThanOrEqual(0);
    expect(unchecked).toBeLessThan(allowed);
  });

  it("names which part of Butler could not be checked", async () => {
    // "I could not check" beside nothing tells a reader something is missing
    // but not WHAT, so they cannot judge which sentences above to trust.
    stubWithFailure("permissions", 501);
    render(<ButlerPage />);
    const row = await screen.findByText(/What you have allowed:/i);
    expect(row).toBeTruthy();
  });

  it("does not render one empty section per source when all is well", async () => {
    // The all-clear used to cost as much attention as an urgent page: five
    // headings, each with its own rendering of "nothing here".
    //
    // An earlier version of THIS test asserted only that no apology and no
    // alert appeared, and passed while all five empty sections were still on
    // the page — a test named for a guarantee it never checked. It now counts
    // the headings.
    stubAllEmpty();
    const { container } = render(<ButlerPage />);
    await screen.findByText(/Nothing is waiting for your decision/i);

    const headings = Array.from(container.querySelectorAll("h2")).map((h) =>
      (h.textContent ?? "").trim(),
    );
    // Sections whose only content would be "nothing here" are gone entirely.
    expect(headings.join(" | ")).not.toMatch(/need to ask you/i);
    expect(headings.join(" | ")).not.toMatch(/already said I could/i);
    expect(headings.join(" | ")).not.toMatch(/noticed/i);
    // What survives is the reference material a reader may still want.
    expect(headings.length).toBeLessThanOrEqual(2);

    expect(
      headings.filter((h) => /could not check/i.test(h)),
    ).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("brings a section back the moment it has something to show", async () => {
    // Compression must not become suppression: the sections above are absent
    // because they are empty, not because they were removed.
    const { container } = render(<ButlerPage />); // default stub has an ask
    await screen.findByText("Push the release branch");
    const headings = Array.from(container.querySelectorAll("h2")).map((h) =>
      (h.textContent ?? "").trim(),
    );
    expect(headings.join(" | ")).toMatch(/need to ask you/i);
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

describe("a wrong shape is not an empty result", () => {
  it("refuses a 200 whose wrapped array is missing", async () => {
    // The 502 lesson wearing a success code: the response parsed, nothing
    // threw, and the page would have said "nothing allowed" about a payload it
    // did not understand.
    stubMalformed("permissions", { permissions: { oops: true } });
    render(<ButlerPage />);
    // Both the named unavailable row and the affected section say so, which
    // is the point: a reader meets it wherever they entered the page.
    expect(
      (await screen.findAllByText(/could not make sense of the answer/i)).length,
    ).toBeGreaterThan(0);
  });

  it("refuses a bare /approvals body that is not an array", async () => {
    // /approvals returns a BARE array. A wrapper appearing here would be a
    // server change, not an empty queue.
    stubMalformed("approvals", { pending: [] });
    render(<ButlerPage />);
    expect(
      await screen.findByText(
        /could not find out whether anything is waiting/i,
      ),
    ).toBeTruthy();
  });

  it("does not report zero pending when the shape drifted", async () => {
    stubMalformed("approvals", { pending: [] });
    render(<ButlerPage />);
    await screen.findByText(/could not find out whether anything is waiting/i);
    expect(screen.queryByText(/Nothing is waiting for your decision/i)).toBeNull();
  });
});

describe("still exactly one announcer", () => {
  it("counts implicit live regions, not only aria-live ones", async () => {
    // `role="status"` carries implicit polite live semantics, so a visible
    // headline marked that way becomes a SECOND announcer — approving
    // something would be read out twice. A query for [aria-live="polite"]
    // alone cannot see it, which is how it was nearly shipped.
    const { container } = render(<ButlerPage />);
    await screen.findByText("Push the release branch");
    const explicit = container.querySelectorAll('[aria-live="polite"]');
    const implicit = container.querySelectorAll(
      '[role="status"], [role="log"], [role="alert"]',
    );
    const all = new Set<Element>([...explicit, ...implicit]);
    expect(all.size).toBe(1);
  });
});

describe("memory: forget is reversible, erase is not", () => {
  it("warns before erasing, and the warning says there is no undo", async () => {
    render(<ButlerPage />);
    const start = await screen.findAllByRole("button", {
      name: /erase this for good/i,
    });
    fireEvent.click(start[0] as HTMLElement);

    // The warning must precede the act — it is the only place it can change
    // anyone's mind.
    expect(await screen.findByText(/there is no undo/i)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /yes, erase it for good/i }),
    ).toBeTruthy();
    // And the safe choice is offered beside it, not buried.
    expect(screen.getByRole("button", { name: /keep it/i })).toBeTruthy();
  });

  it("offers NO undo after an erasure", async () => {
    // The store keeps a content-free husk; there is nothing to put back. An
    // undo offered here would be a promise the API cannot keep.
    render(<ButlerPage />);
    const start = await screen.findAllByRole("button", {
      name: /erase this for good/i,
    });
    fireEvent.click(start[0] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: /yes, erase it for good/i }),);
    await screen.findByText(/erased for good/i);
    expect(screen.queryByRole("button", { name: /undo that/i })).toBeNull();
  });

  it("still offers an undo after a FORGET, which is reversible", async () => {
    render(<ButlerPage />);
    const forget = await screen.findAllByRole("button", {
      name: /forget this about me/i,
    });
    fireEvent.click(forget[0] as HTMLElement);
    expect(
      await screen.findByRole("button", { name: /undo that/i }),
    ).toBeTruthy();
  });
});

describe("memory: an undo survives a reload", () => {
  it("is still offered after the page is mounted again", async () => {
    // The offer used to hold a closure, so a refresh destroyed it — and
    // refreshing is exactly what somebody does when a page surprises them.
    const first = render(<ButlerPage />);
    const forget = await screen.findAllByRole("button", {
      name: /forget this about me/i,
    });
    fireEvent.click(forget[0] as HTMLElement);
    await screen.findByRole("button", { name: /undo that/i });
    first.unmount();

    render(<ButlerPage />);
    expect(
      await screen.findByRole("button", { name: /undo that/i }),
    ).toBeTruthy();
  });

  it("withdraws an offer that no longer works, and says why", async () => {
    // A persisted offer can outlive what it reverses. Pressing a button that
    // silently does nothing is worse than being told.
    // The bridge no longer has that tombstone — restored in another tab, or
    // rotated away. Everything else answers normally.
    stubWithFailure("restore", 404);
    window.localStorage.setItem(
      "patchwork.butler.undo.v1",
      JSON.stringify([
        {
          id: "stale",
          did: 'Removed "Timezone — Europe/London"',
          path: "/api/bridge/butler/facts/999/restore",
          said: "Put back",
        },
      ]),
    );
    render(<ButlerPage />);
    fireEvent.click(await screen.findByRole("button", { name: /undo that/i }),);
    expect(
      await screen.findByText(/may already have been put back/i),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /undo that/i })).toBeNull();
  });
});

describe("memory: a fact reads as a labelled value", () => {
  it("does not render the subject-predicate-object row shape", async () => {
    const { container } = render(<ButlerPage />);
    await screen.findByText("Push the release branch");
    // "You — timezone: Europe/London" was the shape that made Home read like a
    // database table.
    expect(container.textContent ?? "").not.toMatch(/You — \w+:/);
  });

  it("says how long ago as well as the date", async () => {
    render(<ButlerPage />);
    expect(
      await screen.findByText(/Recorded (today|yesterday|\d+ (days|weeks|months|years) ago), on /i),
    ).toBeTruthy();
  });
});
