/**
 * Shared plain-text preview helpers for markdown-authored inbox content.
 *
 * `stripMarkdown` was originally a private helper in
 * app/inbox/page.tsx — extracted here so the Terminal deck's inbox pane
 * (app/page.tsx) can render the same clean preview instead of showing raw
 * `**bold**` / `# heading` syntax.
 */

/** Strip common markdown syntax down to plain text for a one-line preview. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    // Drop GFM table delimiter rows ("| --- | :--: |") entirely — they
    // carry no content, only render as "|---|---|" noise in the preview.
    .replace(/^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/gm, "")
    // Flatten remaining table rows: split cells on pipes, keep the text.
    .replace(/^\s*\|(.+)\|\s*$/gm, (_, row: string) =>
      row
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean)
        .join(" · "),
    )
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/^[-*]\s+/gm, "")
    .replace(/_(.+?)_/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\n+/g, " ")
    .trim();
}

/**
 * Truncate `text` to at most `maxLen` characters, cutting at the last word
 * boundary at or before the limit (never mid-word) and appending an
 * ellipsis. Returns `text` unchanged if it already fits.
 */
export function truncateAtWordBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const slice = text.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

/** Convenience: strip markdown, then truncate at a word boundary. */
export function previewText(text: string, maxLen: number): string {
  return truncateAtWordBoundary(stripMarkdown(text), maxLen);
}
