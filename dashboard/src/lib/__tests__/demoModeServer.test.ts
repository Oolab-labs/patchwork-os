/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `next/headers` only works inside a request lifecycle, so we mock the
// `cookies()` helper. The `cookies` export is the function under test;
// each case overrides its behavior.
let cookieStore: Map<string, { value: string }> | { throws: true };

vi.mock("next/headers", () => ({
  cookies: () => {
    if (
      typeof cookieStore === "object" &&
      "throws" in cookieStore &&
      cookieStore.throws
    ) {
      throw new Error("called outside request context");
    }
    const map = cookieStore as Map<string, { value: string }>;
    return {
      get: (k: string) => map.get(k),
    };
  },
}));

import { isDemoModeServer } from "@/lib/demoModeServer";

const ORIGINAL_ENV = process.env.NEXT_PUBLIC_DEMO_MODE;

beforeEach(() => {
  cookieStore = new Map();
  delete process.env.NEXT_PUBLIC_DEMO_MODE;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
  } else {
    process.env.NEXT_PUBLIC_DEMO_MODE = ORIGINAL_ENV;
  }
});

describe("isDemoModeServer", () => {
  it("returns false by default (no cookie, no env var)", () => {
    expect(isDemoModeServer()).toBe(false);
  });

  it("returns true when the pw-demo cookie is 'true'", () => {
    (cookieStore as Map<string, { value: string }>).set("pw-demo", {
      value: "true",
    });
    expect(isDemoModeServer()).toBe(true);
  });

  it("cookie 'false' wins over env var 'true' (explicit user override)", () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = "true";
    (cookieStore as Map<string, { value: string }>).set("pw-demo", {
      value: "false",
    });
    expect(isDemoModeServer()).toBe(false);
  });

  it("falls back to env var when no cookie is set", () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = "true";
    expect(isDemoModeServer()).toBe(true);
  });

  it("only accepts the literal 'true' env value (not '1' / 'TRUE')", () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = "1";
    expect(isDemoModeServer()).toBe(false);
    process.env.NEXT_PUBLIC_DEMO_MODE = "TRUE";
    expect(isDemoModeServer()).toBe(false);
  });

  it("falls back to env var when cookies() throws (outside request context, e.g. build)", () => {
    cookieStore = { throws: true };
    process.env.NEXT_PUBLIC_DEMO_MODE = "true";
    expect(isDemoModeServer()).toBe(true);
  });

  it("returns false when cookies() throws and env var is unset", () => {
    cookieStore = { throws: true };
    expect(isDemoModeServer()).toBe(false);
  });
});
