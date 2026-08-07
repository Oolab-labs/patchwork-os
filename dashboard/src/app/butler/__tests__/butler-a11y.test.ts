/**
 * The acceptance criteria from §5 of the plan, as a test.
 *
 * These are the deliverable. The page is not done until each passes, and a
 * later change that breaks one has to break a test to do it — which is the
 * point. Accessibility regressions are invisible to whoever causes them.
 *
 * WHY THIS PARSES THE CSS FILE rather than asserting computed styles: jsdom
 * does not lay out or cascade an imported stylesheet, so `getComputedStyle`
 * in a component test reports the initial value for everything and would
 * happily "pass" against a stylesheet that says 9px. Reading the declarations
 * is less glamorous and actually true.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AAA_TEXT, contrastRatio, NON_TEXT } from "@/lib/contrast";

const CSS = readFileSync(path.join(__dirname, "..", "butler.css"), "utf8");
/** Declarations only — comments stripped. Needed wherever a test looks for
 *  the ABSENCE of something, since this file's prose names the anti-patterns
 *  it forbids and a naive match would fail on the documentation. */
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/** Read a custom property's value from a given selector block. */
function tokenIn(block: string, name: string): string {
  const m = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(block);
  if (!m?.[1]) throw new Error(`token ${name} not found`);
  return m[1].trim();
}

/** The declaration block for a selector, so light and dark can be read apart. */
function blockFor(selector: string): string {
  const idx = CSS.indexOf(selector);
  if (idx === -1) throw new Error(`selector ${selector} not found`);
  const open = CSS.indexOf("{", idx);
  const close = CSS.indexOf("}", open);
  return CSS.slice(open, close);
}

const px = (v: string): number => Number.parseFloat(v.replace("px", ""));

const base = blockFor(".butler {");
const dark = blockFor('@media (prefers-color-scheme: dark)');
const comfortable = blockFor('.butler[data-density="comfortable"]');

describe("A1 — nothing under 18px", () => {
  it("body text is at least 18px and primary content at least 21px", () => {
    expect(px(tokenIn(base, "--lp-text"))).toBeGreaterThanOrEqual(18);
    expect(px(tokenIn(base, "--lp-text-primary"))).toBeGreaterThanOrEqual(21);
    expect(px(tokenIn(base, "--lp-text-heading"))).toBeGreaterThanOrEqual(21);
  });

  it("the density layer never shrinks type below the floor", () => {
    // The comfortable layer may tighten spacing. It may not undo A1 — that
    // would make large print a mode again, which is the thing this design
    // exists to avoid.
    for (const name of ["--lp-text", "--lp-text-primary"]) {
      const m = new RegExp(`${name}\\s*:`).exec(comfortable);
      if (m) expect(px(tokenIn(comfortable, name))).toBeGreaterThanOrEqual(18);
    }
    expect(px(tokenIn(comfortable, "--lp-text-heading"))).toBeGreaterThanOrEqual(
      21,
    );
  });
});

describe("A2 — contrast is AAA for text, 3:1 for non-text", () => {
  const pairs = (block: string) => {
    const bg = tokenIn(block, "--lp-bg");
    return {
      bg,
      fg: tokenIn(block, "--lp-fg"),
      soft: tokenIn(block, "--lp-fg-soft"),
      line: tokenIn(block, "--lp-line-colour"),
      accent: tokenIn(block, "--lp-accent"),
      accentFg: tokenIn(block, "--lp-accent-fg"),
      danger: tokenIn(block, "--lp-danger"),
      focus: tokenIn(block, "--lp-focus"),
    };
  };

  for (const [name, block] of [
    ["light", base],
    ["dark", dark],
  ] as const) {
    describe(name, () => {
      const p = pairs(block);

      it("body and muted text clear 7:1", () => {
        expect(contrastRatio(p.fg, p.bg)).toBeGreaterThanOrEqual(AAA_TEXT);
        // `--lp-fg-soft` carries the source-of-a-fact sentence, which is
        // ordinary body text at 18px, not decoration. It gets the text floor.
        expect(contrastRatio(p.soft, p.bg)).toBeGreaterThanOrEqual(AAA_TEXT);
      });

      it("the accent clears 7:1 as text, and its own label clears 7:1 on it", () => {
        // This is the check §8 flagged: the house orange #c5532a is 4.4:1 on
        // white — AA at large sizes, short of the AAA floor this page holds
        // itself to. #a33c17 (the plan's suggestion) is 6.53:1 — also short.
        // Hence #8f3413 at 7.87:1.
        expect(contrastRatio(p.accent, p.bg)).toBeGreaterThanOrEqual(AAA_TEXT);
        expect(contrastRatio(p.accentFg, p.accent)).toBeGreaterThanOrEqual(
          AAA_TEXT,
        );
      });

      it("danger text clears 7:1", () => {
        expect(contrastRatio(p.danger, p.bg)).toBeGreaterThanOrEqual(AAA_TEXT);
      });

      it("borders and the focus ring clear 3:1 (1.4.11 / 2.4.11)", () => {
        expect(contrastRatio(p.line, p.bg)).toBeGreaterThanOrEqual(NON_TEXT);
        expect(contrastRatio(p.focus, p.bg)).toBeGreaterThanOrEqual(NON_TEXT);
      });

      it("the ring does not have to fight the button it outlines", () => {
        // This assertion started as `focus vs accent >= 3` and FAILED at
        // 1.5:1 — the focus blue is invisible on the dark-orange primary
        // button, which is the single most important control on the page.
        //
        // The fix is structural rather than another colour hunt: a
        // background-coloured gap ring separates the outline from the
        // control, so the outline only ever sits on `--lp-bg`. Asserting the
        // gap exists is what keeps the fix; the `focus vs bg` check above is
        // then sufficient.
        expect(CSS).toMatch(
          /:focus-visible\s*{[^}]*box-shadow:\s*0 0 0 3px var\(--lp-bg\)/,
        );
      });
    });
  }

  it("the house orange would NOT have passed — the darker accent is load-bearing", () => {
    // Pinned so nobody "restores the brand colour" without seeing why it was
    // changed. If this ever fails, the palette moved, not the rule.
    expect(contrastRatio("#c5532a", "#ffffff")).toBeLessThan(AAA_TEXT);
    // The plan proposed #a33c17 and said "verify before committing". Verified:
    // 6.53:1 — short of AAA too. The recommendation was close but wrong, and
    // this pins the measurement so the next person does not re-adopt it.
    expect(contrastRatio("#a33c17", "#ffffff")).toBeLessThan(AAA_TEXT);
    // What shipped instead.
    expect(contrastRatio("#8f3413", "#ffffff")).toBeGreaterThanOrEqual(
      AAA_TEXT,
    );
  });
});

describe("A4 — interactive targets are at least 44x44", () => {
  it("the target floor is 44px and the default is larger", () => {
    expect(px(tokenIn(base, "--lp-target-min"))).toBeGreaterThanOrEqual(44);
    expect(px(tokenIn(base, "--lp-target"))).toBeGreaterThanOrEqual(44);
  });

  it("the density layer never shrinks a target below the floor", () => {
    expect(px(tokenIn(comfortable, "--lp-target"))).toBeGreaterThanOrEqual(44);
  });

  it("every min-height is either a target token or a literal ≥44px", () => {
    const declarations = Array.from(
      CSS.matchAll(/min-height:\s*([^;]+);/g),
      (m) => (m[1] ?? "").trim(),
    );
    expect(declarations.length).toBeGreaterThan(0);
    for (const d of declarations) {
      if (d.startsWith("var(--lp-target")) continue; // token-bound, checked above
      const literal = /^(\d+)px$/.exec(d);
      expect(literal, `unexpected min-height: ${d}`).not.toBeNull();
      expect(Number(literal?.[1])).toBeGreaterThanOrEqual(44);
    }
  });
});

describe("A5 — focus is always visible", () => {
  it("declares a focus-visible outline", () => {
    expect(CSS).toMatch(/:focus-visible\s*{[^}]*outline:\s*3px/);
  });

  it("never removes an outline anywhere", () => {
    // `outline: none` is the single most common way a page becomes
    // keyboard-unusable, and it is usually added to fix a cosmetic complaint.
    // Comments are stripped first — the prose in this file says the words
    // "outline: none" to explain the rule, and matching that would be a test
    // failing on its own documentation.
    expect(CODE).not.toMatch(/outline:\s*(none|0)\b/);
  });
});

describe("A8 — reflows at 320px", () => {
  it("the column is width-constrained by max-width, not a fixed width", () => {
    expect(base).not.toMatch(/(?<!max-)width:\s*\d/);
    expect(base).toMatch(/max-width:/);
  });

  it("wide content scrolls inside its own container, not the page", () => {
    expect(CSS).toMatch(/\.butlerScroll\s*{[^}]*overflow-x:\s*auto/);
  });
});

describe("the seam with the rest of the dashboard", () => {
  it("clears the shell's fixed bottom nav", () => {
    // Found by opening the page in a real browser at 320px, which no unit
    // test here could have caught: the tests render the page alone, and the
    // 63px bar belongs to the shell. It sat on top of "Take this back" — the
    // control that withdraws a standing permission — making it untappable
    // while every assertion in this file passed.
    //
    // `--bottom-nav-h` is the shell's own variable and is 0 where there is no
    // bar, so this is also correct on desktop.
    // Every rule that sets the PAGE's padding — the base block and the
    // narrow-viewport override. Row padding is a different thing and is not
    // in scope here.
    const pageRules = [base, blockFor("@media (max-width: 420px)")];
    for (const rule of pageRules) {
      const m = /padding:\s*([^;]+);/.exec(rule);
      expect(m?.[1], "page rule sets no padding").toBeTruthy();
      expect(m?.[1], `padding without bottom-nav clearance: ${m?.[1]}`)
        .toContain("--bottom-nav-h");
      expect(m?.[1]).toContain("safe-area-inset-bottom");
    }
  });
});

describe("A10 — honours prefers-reduced-motion and prefers-contrast", () => {
  it("cancels animation and transition under reduced-motion", () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(CSS).toMatch(/animation-duration:\s*0\.001ms\s*!important/);
    expect(CSS).toMatch(/transition-duration:\s*0\.001ms\s*!important/);
  });

  it("strengthens borders and text under prefers-contrast: more", () => {
    expect(CSS).toMatch(/@media \(prefers-contrast: more\)/);
  });
});

describe("theme", () => {
  it("the viewer's explicit choice wins in BOTH directions", () => {
    // A dark-preferring reader who picks light must get light. Only handling
    // one direction is the usual half-fix.
    expect(CSS).toMatch(/:root\[data-theme="light"\] \.butler/);
    expect(CSS).toMatch(/:root\[data-theme="dark"\] \.butler/);
  });
});
