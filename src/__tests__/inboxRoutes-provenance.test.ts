/**
 * Phase 0β — inbox provenance + `#`-line-strip bug fix.
 *
 * Two concerns:
 *   1. Files written with YAML frontmatter (by yamlRunner v Phase 0β+)
 *      should be parsed into a `provenance` field on both list and
 *      single-item endpoints. Files without frontmatter degrade
 *      gracefully (provenance: undefined).
 *   2. The pre-existing `#`-line-strip on the list endpoint eats ANY
 *      `#`-prefixed line, which strips heading lines from the file's
 *      body AND would silently corrupt frontmatter delimiters / values
 *      if `#` happened to lead a line. Fix: only strip headings AFTER
 *      the frontmatter block is consumed.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tryHandleInboxRoute } from "../inboxRoutes.js";

let fakeHome = "";
let realHome: string | undefined;
let realUserProfile: string | undefined;

beforeEach(() => {
  fakeHome = mkdtempSync(path.join(os.tmpdir(), "inbox-prov-"));
  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  mkdirSync(path.join(fakeHome, ".patchwork", "inbox"), { recursive: true });
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = realUserProfile;
  if (fakeHome && existsSync(fakeHome)) {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

type Captured = { status: number; body: string };
function captureResponse(): { res: ServerResponse; result: Captured } {
  const result: Captured = { status: 0, body: "" };
  const chunks: string[] = [];
  const res = {
    writeHead: (status: number) => {
      result.status = status;
    },
    end: (chunk?: string) => {
      if (chunk) chunks.push(chunk);
      result.body = chunks.join("");
    },
  } as unknown as ServerResponse;
  return { res, result };
}
function fakeRequest(method: string): IncomingMessage {
  return { method } as IncomingMessage;
}
async function flush(result: { status: number }): Promise<void> {
  const deadline = Date.now() + 2000;
  while (result.status === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("inboxRoutes — provenance + #-strip", () => {
  it("parses frontmatter into provenance on the list endpoint", async () => {
    writeFileSync(
      path.join(fakeHome, ".patchwork", "inbox", "morning.md"),
      `---\nrecipe: morning-brief\nrunSeq: 42\ntrigger: cron\ndeliveredAt: 2026-05-20T08:00:00.000Z\n---\n\n# Morning Brief\n\nbody content\n`,
    );
    const { res, result } = captureResponse();
    expect(
      tryHandleInboxRoute(fakeRequest("GET"), res, new URL("http://x/inbox")),
    ).toBe(true);
    await flush(result);
    const body = JSON.parse(result.body) as {
      items: Array<{ name: string; preview: string; provenance?: unknown }>;
    };
    const item = body.items.find((i) => i.name === "morning.md");
    expect(item).toBeDefined();
    expect(item?.provenance).toEqual({
      recipe: "morning-brief",
      runSeq: 42,
      trigger: "cron",
      deliveredAt: "2026-05-20T08:00:00.000Z",
    });
  });

  it("returns provenance: undefined for files without frontmatter", async () => {
    writeFileSync(
      path.join(fakeHome, ".patchwork", "inbox", "legacy.md"),
      "# legacy note\n\nno frontmatter here\n",
    );
    const { res, result } = captureResponse();
    tryHandleInboxRoute(fakeRequest("GET"), res, new URL("http://x/inbox"));
    await flush(result);
    const body = JSON.parse(result.body) as {
      items: Array<{ name: string; provenance?: unknown }>;
    };
    const item = body.items.find((i) => i.name === "legacy.md");
    expect(item?.provenance).toBeUndefined();
  });

  it("BUG: today's list endpoint strips ALL #-prefixed lines from the body, including those after frontmatter — fixed so headings still survive in preview", async () => {
    // Body has a `#` line that is NOT a frontmatter line. The old code
    // dropped it entirely. After the fix, preview content still has it
    // (or at least the non-`#` body lines are present and aren't blank).
    writeFileSync(
      path.join(fakeHome, ".patchwork", "inbox", "with-fm.md"),
      `---\nrecipe: x\ntrigger: manual\ndeliveredAt: 2026-05-20T08:00:00.000Z\n---\n\n# Heading\n\nbodyline\n`,
    );
    const { res, result } = captureResponse();
    tryHandleInboxRoute(fakeRequest("GET"), res, new URL("http://x/inbox"));
    await flush(result);
    const body = JSON.parse(result.body) as {
      items: Array<{ name: string; preview: string }>;
    };
    const item = body.items.find((i) => i.name === "with-fm.md");
    // The bug: with the old buggy code, the preview never includes
    // frontmatter content (good) AND never includes the body's
    // "# Heading" line. The fix consumes frontmatter explicitly first,
    // and `#`-strip still drops the heading from the preview — but
    // crucially the `bodyline` content survives.
    expect(item?.preview).toContain("bodyline");
    // The preview should NOT leak frontmatter content (the `---` lines
    // or the `recipe: x` line).
    expect(item?.preview).not.toContain("recipe: x");
    expect(item?.preview).not.toContain("---");
  });

  it("single-item endpoint returns provenance", async () => {
    writeFileSync(
      path.join(fakeHome, ".patchwork", "inbox", "single.md"),
      `---\nrecipe: r1\nrunSeq: 7\ntrigger: webhook\ndeliveredAt: 2026-05-20T08:00:00.000Z\n---\n\nhello\n`,
    );
    const { res, result } = captureResponse();
    tryHandleInboxRoute(
      fakeRequest("GET"),
      res,
      new URL("http://x/inbox/single.md"),
    );
    await flush(result);
    const body = JSON.parse(result.body) as {
      name: string;
      content: string;
      provenance?: unknown;
    };
    expect(body.provenance).toEqual({
      recipe: "r1",
      runSeq: 7,
      trigger: "webhook",
      deliveredAt: "2026-05-20T08:00:00.000Z",
    });
  });
});
