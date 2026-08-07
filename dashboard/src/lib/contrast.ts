/**
 * WCAG 2.x relative luminance and contrast ratio.
 *
 * Exists so "text contrast ≥7:1" can be a test rather than a claim. The
 * Butler page holds itself to AAA, and a colour pair that drifts below the
 * floor is exactly the kind of regression nobody notices by looking — the
 * change that breaks it usually looks fine to whoever made it.
 *
 * Formulae: WCAG 2.2 §Contrast (Minimum), relative luminance definition.
 */

/** `#rgb` or `#rrggbb` → [r, g, b] in 0..255. Throws on anything else, so a
 *  typo in a token fails loudly instead of silently scoring 21:1 against
 *  black. */
export function parseHex(hex: string): [number, number, number] {
  const h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    const [r, g, b] = h.split("");
    return [
      Number.parseInt(`${r}${r}`, 16),
      Number.parseInt(`${g}${g}`, 16),
      Number.parseInt(`${b}${b}`, 16),
    ];
  }
  if (h.length === 6) {
    return [
      Number.parseInt(h.slice(0, 2), 16),
      Number.parseInt(h.slice(2, 4), 16),
      Number.parseInt(h.slice(4, 6), 16),
    ];
  }
  throw new Error(`not a hex colour: ${hex}`);
}

/** WCAG relative luminance, 0 (black) .. 1 (white). */
export function relativeLuminance(hex: string): number {
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = parseHex(hex);
  return (
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  );
}

/** Contrast ratio between two colours, 1..21. Order-independent. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG AAA floor for body text. */
export const AAA_TEXT = 7;
/** WCAG AA floor for large text (≥18.66px bold or ≥24px). */
export const AA_LARGE = 3;
/** WCAG 1.4.11 floor for UI components and graphical objects. */
export const NON_TEXT = 3;
