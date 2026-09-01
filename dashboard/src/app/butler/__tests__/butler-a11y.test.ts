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

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AAA_TEXT, contrastRatio, NON_TEXT } from "@/lib/contrast";

/**
 * EVERY stylesheet under the Butler tree, not one hardcoded file.
 *
 * The original read `butler.css` by name. That was correct while Butler was
 * one page, and silently wrong the moment a second stylesheet appears — an
 * onboarding flow, a sub-route, anything. The new file would be unchecked,
 * and nothing would say so: the suite would stay green while the guarantees
 * stopped covering half the surface.
 *
 * The empty case is asserted below. A glob that matches nothing passes every
 * "must not contain" test in this file, which is the most dangerous shape a
 * check like this can take.
 */
function cssFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      out.push(...cssFilesUnder(full));
    } else if (entry.endsWith(".css")) {
      out.push(full);
    }
  }
  return out;
}

const BUTLER_DIR = path.join(__dirname, "..");
const CSS_FILES = cssFilesUnder(BUTLER_DIR).sort();
/** Every Butler stylesheet concatenated — what the whole-tree sweeps read. */
const CSS = CSS_FILES.map((f) => readFileSync(f, "utf8")).join("\n");
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

/**
 * The declaration block for a selector, so light and dark can be read apart.
 *
 * Brace-MATCHED. It used to take the first `}` after the opening brace, which
 * for an `@media` block returns only its first inner rule. Latent rather than
 * harmful while the dark block held one rule — it captured 296 of 298
 * characters — but a second rule added to any media query would have fallen
 * outside the assertions with nothing to say so.
 */
function blockFor(selector: string): string {
  const idx = CSS.indexOf(selector);
  if (idx === -1) throw new Error(`selector ${selector} not found`);
  const open = CSS.indexOf("{", idx);
  let depth = 0;
  for (let i = open; i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    else if (CSS[i] === "}") {
      depth--;
      if (depth === 0) return CSS.slice(open, i);
    }
  }
  throw new Error(`unbalanced braces after ${selector}`);
}

/**
 * Text of every rule whose selector names an interactive control.
 *
 * Two calibrations, both learned by running it against the real stylesheet:
 *
 *  - The selector match is explicit. A first attempt included a bare `a\b`
 *    for anchors, which matches a standalone letter and pulled in unrelated
 *    rules. A check that flags correct code gets deleted, not fixed.
 *  - Visually-hidden blocks are excluded. `position: absolute` with 1×1px is
 *    the standard screen-reader-only technique — `.butlerAnnounce`, the live
 *    region, is exactly that — and it is the OPPOSITE of an accessibility
 *    problem. Flagging it would have argued for making the live region
 *    44px, which is nonsense.
 */
function controlBlocksText(): string {
  const out: string[] = [];
  for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (m[1] ?? "").trim();
    const body = m[2] ?? "";
    const isControl =
      /\bbutton\b|\[role="button"\]|\binput\b|\bselect\b|\btextarea\b|Button|Action|Toggle/i.test(
        selector,
      );
    if (!isControl) continue;
    const visuallyHidden =
      /position:\s*absolute/.test(body) &&
      /width:\s*1px/.test(body) &&
      /height:\s*1px/.test(body);
    if (visuallyHidden) continue;
    out.push(body);
  }
  return out.join("\n");
}

/** Every top-level rule body in the sheet, for whole-tree sweeps. */
function allBlocks(): string[] {
  const blocks: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < CSS.length; i++) {
    if (CSS[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (CSS[i] === "}") {
      depth--;
      if (depth === 0 && start !== -1) blocks.push(CSS.slice(start, i));
    }
  }
  return blocks;
}

const px = (v: string): number => Number.parseFloat(v.replace("px", ""));

const base = blockFor(".butler {");
const dark = blockFor('@media (prefers-color-scheme: dark)');
const comfortable = blockFor('.butler[data-density="comfortable"]');

describe("the sweep covers something", () => {
  it("finds at least one Butler stylesheet", () => {
    // Without this, every "must not contain" assertion below passes over an
    // empty string. A renamed directory would turn this whole file into a
    // suite that proves nothing while staying green — the single most likely
    // way these guarantees are lost.
    expect(CSS_FILES.length).toBeGreaterThan(0);
    expect(CSS.length).toBeGreaterThan(500);
  });
});

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

describe("A1b — no literal font-size under 18px anywhere in the tree", () => {
  it("every literal px font-size is at least 18px", () => {
    // A1 checks the TOKENS. A stylesheet added later can ignore the tokens
    // entirely and write `font-size: 14px`, which is the ordinary way this
    // guarantee is lost — nobody edits a token to make text small, they just
    // write a smaller number in a new file.
    const offenders: string[] = [];
    for (const m of CSS.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) {
      if (Number(m[1]) < 18) offenders.push(m[0]);
    }
    expect(offenders, `font sizes under 18px: ${offenders.join(", ")}`)
      .toHaveLength(0);
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

  it("no sizing declaration puts a control under 44px", () => {
    // `min-height` alone was checked. A control sized with `height: 32px` —
    // the more natural way to write it — was invisible to this, and height is
    // a HARDER constraint than min-height, so the narrower sweep missed the
    // stricter mistake.
    const PROPS = ["min-height", "height", "min-width", "width"];
    const found: string[] = [];
    for (const prop of PROPS) {
      for (const m of CSS.matchAll(
        new RegExp(`(?<![\\w-])${prop}:\\s*([^;]+);`, "g"),
      )) {
        const value = (m[1] ?? "").trim();
        if (value.startsWith("var(--lp-target")) continue; // checked above
        // Only literal pixel values can be judged here. Percentages, `auto`,
        // `100%`, `fit-content` and calc() depend on layout, which this file
        // cannot see — flagging them would make the check unusable and it
        // would be turned off.
        const literal = /^(\d+(?:\.\d+)?)px$/.exec(value);
        if (!literal) continue;
        if (Number(literal[1]) < 44) found.push(`${prop}: ${value}`);
      }
    }
    // Sizes below 44px are legitimate on non-interactive things — a rule, an
    // icon, a gap. So this is scoped to declarations inside a block whose
    // selector mentions a control.
    const controlSized = found.filter((d) => controlBlocksText().includes(d));
    expect(controlSized, `control sized under 44px: ${controlSized.join(", ")}`)
      .toHaveLength(0);
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

  it("no rule anywhere pins a width wider than 320px", () => {
    // Only `.butler {` was checked. A fixed width on any OTHER rule breaks
    // reflow just as thoroughly, and a multi-step flow is exactly where one
    // gets added — a progress bar, a step panel, a button row.
    const offenders: string[] = [];
    for (const block of allBlocks()) {
      for (const m of block.matchAll(/(?<![\w-])width:\s*(\d+(?:\.\d+)?)px/g)) {
        if (Number(m[1]) > 320) offenders.push(m[0]);
      }
    }
    expect(offenders, `fixed widths over 320px: ${offenders.join(", ")}`)
      .toHaveLength(0);
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

  it("cancels motion across the whole SUBTREE, not rule by rule", () => {
    // This is what makes a stylesheet added later safe by default. The
    // override is `.butler *` with !important, so a transition in a new file
    // is cancelled without anyone remembering to guard it.
    //
    // Asserting the descendant-universal form rather than "no unguarded
    // transition exists" is deliberate: the latter was the obvious test to
    // write and it would have flagged correct code, because a transition
    // inside the subtree is ALREADY covered. What must not happen is someone
    // narrowing this override to a list of selectors, at which point new
    // files silently stop being covered.
    const reduced = blockFor("@media (prefers-reduced-motion: reduce)");
    expect(reduced).toMatch(/\.butler\s*\*/);
    expect(reduced).toMatch(/animation-duration:\s*0\.001ms\s*!important/);
    expect(reduced).toMatch(/transition-duration:\s*0\.001ms\s*!important/);
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

describe("headings take Butler's own palette, not the shell's", () => {
  /**
   * A regression for a bug the whole suite was blind to.
   *
   * `.butler h1/h2` declared no colour and INHERITED — and inheritance loses to
   * any direct rule, so the dashboard shell's `h1, h2 { color: … }` won. In
   * dark theme the shell's near-white happened to match Butler's foreground and
   * nothing looked wrong. In light theme the headings computed to
   * rgb(246,247,248) on a white page: "Butler" and every section heading,
   * invisible, on the page a first-time user lands on.
   *
   * Every contrast assertion in this file passed throughout, because they check
   * the ratios of Butler's OWN tokens and those were always correct. What was
   * wrong was which palette reached the element — which a stylesheet-parsing
   * test cannot see unless it asks whether the rule exists at all.
   */
  it("declares a colour for headings rather than inheriting one", () => {
    const block = blockFor(".butler h1,\n.butler h2,\n.butler h3");
    expect(block, "no heading colour rule found").toBeTruthy();
    expect(block).toMatch(/color:\s*var\(--lp-fg\)/);
  });
});
