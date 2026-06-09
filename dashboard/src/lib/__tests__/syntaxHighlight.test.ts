/**
 * LOW #42 — syntaxHighlightJson shared utility
 *
 * The function must:
 *  1. HTML-escape angle brackets, ampersands (XSS-safe).
 *  2. Wrap JSON tokens in spans for syntax highlighting.
 *  3. Be importable from @/lib/syntaxHighlight (shared between both
 *     approvals pages).
 */

import { describe, expect, it } from "vitest";
import { syntaxHighlightJson } from "@/lib/syntaxHighlight";

describe("syntaxHighlightJson (LOW #42)", () => {
  it("is importable from @/lib/syntaxHighlight", () => {
    // This will fail until the file exists.
    expect(typeof syntaxHighlightJson).toBe("function");
  });

  it("HTML-escapes < and > in string values (XSS guard)", () => {
    const json = JSON.stringify({ x: "<script>alert(1)</script>" }, null, 2);
    const result = syntaxHighlightJson(json);
    expect(result).not.toContain("<script>");
    expect(result).not.toContain("</script>");
    expect(result).toContain("&lt;script&gt;");
  });

  it("HTML-escapes & in string values", () => {
    const json = JSON.stringify({ q: "a&b" }, null, 2);
    const result = syntaxHighlightJson(json);
    expect(result).not.toContain('"a&b"');
    expect(result).toContain("&amp;");
  });

  it("wraps string values in json-str spans", () => {
    const json = JSON.stringify({ name: "hello" }, null, 2);
    const result = syntaxHighlightJson(json);
    expect(result).toContain('<span class="json-str">');
  });

  it("wraps object keys in json-key spans", () => {
    const json = JSON.stringify({ myKey: 1 }, null, 2);
    const result = syntaxHighlightJson(json);
    expect(result).toContain('<span class="json-key">');
  });

  it("wraps numbers in json-num spans", () => {
    const json = JSON.stringify({ n: 42 }, null, 2);
    const result = syntaxHighlightJson(json);
    expect(result).toContain('<span class="json-num">');
  });

  it("wraps booleans in json-bool spans", () => {
    const json = JSON.stringify({ flag: true }, null, 2);
    const result = syntaxHighlightJson(json);
    expect(result).toContain('<span class="json-bool">');
  });

  it("wraps null in json-null spans", () => {
    const json = JSON.stringify({ x: null }, null, 2);
    const result = syntaxHighlightJson(json);
    expect(result).toContain('<span class="json-null">');
  });
});
