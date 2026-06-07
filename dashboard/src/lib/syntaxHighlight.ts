/**
 * Shared JSON syntax highlighter for the approvals UI.
 *
 * Tokenises a JSON string into HTML spans with colour classes, HTML-escaping
 * angle brackets and ampersands first (XSS guard). Moved here from
 * `app/approvals/[callId]/page.tsx` so both the list page and the detail page
 * can share the same implementation (LOW #42).
 *
 * Usage:
 *   <pre dangerouslySetInnerHTML={{ __html: syntaxHighlightJson(json) }} />
 */
export function syntaxHighlightJson(json: string): string {
  return json
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
      (match) => {
        if (/^"/.test(match)) {
          if (/:$/.test(match)) {
            return `<span class="json-key">${match}</span>`;
          }
          return `<span class="json-str">${match}</span>`;
        }
        if (/true|false/.test(match)) return `<span class="json-bool">${match}</span>`;
        if (/null/.test(match)) return `<span class="json-null">${match}</span>`;
        return `<span class="json-num">${match}</span>`;
      },
    );
}
