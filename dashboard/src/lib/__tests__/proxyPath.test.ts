/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { joinPathSegments } from "../proxyPath";

describe("joinPathSegments — decoded route params back onto the wire", () => {
  it("joins ordinary segments with a slash, unchanged", () => {
    expect(joinPathSegments(["recipes", "morning-brief", "run"])).toBe(
      "recipes/morning-brief/run",
    );
  });

  // Next hands route handlers DECODED params. A single segment that came in
  // as `recipes%2Finstall` arrives as the string "recipes/install"; joined
  // raw, the upstream sees `/recipes/install` — a different endpoint than the
  // one-segment path the catch-all was handed, and one a dedicated proxy with
  // its own controls was supposed to own. Re-encoding puts the `%2F` back.
  it("re-encodes a slash INSIDE a segment so it cannot become a path separator", () => {
    expect(joinPathSegments(["recipes/install"])).toBe("recipes%2Finstall");
  });

  it("re-encodes ? and # so a segment cannot start a query string or fragment", () => {
    expect(joinPathSegments(["recipes", "doctor?recipe=x"])).toBe(
      "recipes/doctor%3Frecipe%3Dx",
    );
    expect(joinPathSegments(["a#b"])).toBe("a%23b");
  });

  it("re-encodes a backslash and control characters", () => {
    expect(joinPathSegments(["a\\b"])).toBe("a%5Cb");
    expect(joinPathSegments(["a\tb"])).toBe("a%09b");
  });

  it("round-trips through the WHATWG parser as the SAME number of segments", () => {
    const segs = ["recipes/install", "x?y", "z#w"];
    const url = new URL(`http://h/${joinPathSegments(segs)}`);
    expect(url.pathname.split("/").filter(Boolean)).toHaveLength(segs.length);
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
  });
});
