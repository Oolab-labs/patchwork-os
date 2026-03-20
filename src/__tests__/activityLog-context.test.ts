import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ""),
      statSync: vi.fn(() => ({ size: 0 })),
      promises: {
        ...actual.promises,
        appendFile: vi.fn(() => Promise.resolve()),
        stat: vi.fn(() => Promise.resolve({ size: 0 })),
      },
    },
  };
});

import { ActivityLog } from "../activityLog.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ActivityLog context fields", () => {
  it("record() stores sessionId and teammateName when provided", () => {
    const log = new ActivityLog();
    log.record("openFile", 10, "success", undefined, {
      sessionId: "abc12345",
      teammateName: "alice",
    });

    const entries = log.query({});
    expect(entries).toHaveLength(1);
    expect(entries[0]!.sessionId).toBe("abc12345");
    expect(entries[0]!.teammateName).toBe("alice");
  });

  it("record() works without context (backward compat)", () => {
    const log = new ActivityLog();
    log.record("openFile", 10, "success");

    const entries = log.query({});
    expect(entries).toHaveLength(1);
    expect(entries[0]!.sessionId).toBeUndefined();
    expect(entries[0]!.teammateName).toBeUndefined();
  });

  it("recordEvent() stores context fields", () => {
    const log = new ActivityLog();
    log.recordEvent(
      "claude_connected",
      { activeSessions: 1 },
      {
        sessionId: "def67890",
        teammateName: "bob",
      },
    );

    const timeline = log.queryTimeline({ last: 1 });
    expect(timeline).toHaveLength(1);
    const entry = timeline[0]!;
    expect(entry.kind).toBe("lifecycle");
    if (entry.kind === "lifecycle") {
      expect(entry.sessionId).toBe("def67890");
      expect(entry.teammateName).toBe("bob");
    }
  });

  it("recordEvent() works without context (backward compat)", () => {
    const log = new ActivityLog();
    log.recordEvent("test_event");

    const timeline = log.queryTimeline({ last: 1 });
    expect(timeline).toHaveLength(1);
    const entry = timeline[0]!;
    if (entry.kind === "lifecycle") {
      expect(entry.sessionId).toBeUndefined();
      expect(entry.teammateName).toBeUndefined();
    }
  });

  it("context fields appear in listener notifications", () => {
    const log = new ActivityLog();
    const events: Array<{ kind: string; entry: unknown }> = [];
    log.subscribe((kind, entry) => {
      events.push({ kind, entry });
    });

    log.record("runCommand", 100, "success", undefined, {
      sessionId: "sess1234",
      teammateName: "alice",
    });

    expect(events).toHaveLength(1);
    const entry = events[0]!.entry as Record<string, unknown>;
    expect(entry.sessionId).toBe("sess1234");
    expect(entry.teammateName).toBe("alice");
  });
});
