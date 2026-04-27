import { describe, expect, it } from "vitest";
import { parseMeetingNotes } from "../tools/meetingNotes.js";

const SAMPLE_GEMINI = `
# Q2 Planning Sync
Date: 2024-06-10

## Attendees
- Alice Johnson
- Bob Smith
- Carol Lee

## Summary
The team aligned on the Q2 roadmap priorities. Engineering will focus on the payments refactor while marketing prepares the launch assets. A follow-up meeting is scheduled for Friday.

## Action Items
- Alice Johnson: Send updated roadmap to stakeholders by EOD
- Bob Smith: Draft payments API spec
- Unassigned: Book the Friday follow-up room

## Decisions
- Postpone mobile redesign to Q3
- Approve $15k budget for launch campaign

## Open Questions
- Which payment processor to use long-term?
- Will legal approve the updated TOS in time?
`;

describe("parseMeetingNotes", () => {
  it("extracts title", () => {
    const r = parseMeetingNotes(SAMPLE_GEMINI);
    expect(r.meetingTitle).toBe("Q2 Planning Sync");
  });

  it("extracts ISO date", () => {
    const r = parseMeetingNotes(SAMPLE_GEMINI);
    expect(r.meetingDate).toBe("2024-06-10");
  });

  it("extracts attendees", () => {
    const r = parseMeetingNotes(SAMPLE_GEMINI);
    expect(r.attendees).toEqual(["Alice Johnson", "Bob Smith", "Carol Lee"]);
  });

  it("extracts action items with assignees", () => {
    const r = parseMeetingNotes(SAMPLE_GEMINI);
    expect(r.actionItems).toContainEqual({
      assignee: "Alice Johnson",
      task: "Send updated roadmap to stakeholders by EOD",
    });
    expect(r.actionItems).toContainEqual({
      assignee: "Bob Smith",
      task: "Draft payments API spec",
    });
  });

  it("extracts unassigned action item", () => {
    const r = parseMeetingNotes(SAMPLE_GEMINI);
    const unassigned = r.actionItems.find((a) => a.assignee === null);
    expect(unassigned).toBeDefined();
    expect(unassigned!.task).toMatch(/Book the Friday follow-up room/);
  });

  it("extracts decisions", () => {
    const r = parseMeetingNotes(SAMPLE_GEMINI);
    expect(r.decisions).toContain("Postpone mobile redesign to Q3");
    expect(r.decisions).toContain("Approve $15k budget for launch campaign");
  });

  it("extracts open questions", () => {
    const r = parseMeetingNotes(SAMPLE_GEMINI);
    expect(r.openQuestions.length).toBe(2);
    expect(r.openQuestions[0]).toMatch(/payment processor/i);
  });

  it("builds summary prose", () => {
    const r = parseMeetingNotes(SAMPLE_GEMINI);
    expect(r.summaryText.length).toBeGreaterThan(10);
  });

  it("returns empty actionItems when section absent", () => {
    const noActions = SAMPLE_GEMINI.replace(
      /## Action Items[\s\S]*?## Decisions/,
      "## Decisions",
    );
    const r = parseMeetingNotes(noActions);
    expect(r.actionItems).toEqual([]);
  });

  it("parses human-readable date", () => {
    const text = `# Kickoff\nJune 3, 2024\n## Attendees\n- Dan\n`;
    const r = parseMeetingNotes(text);
    expect(r.meetingDate).toBe("2024-06-03");
  });

  it("handles empty string gracefully", () => {
    const r = parseMeetingNotes("");
    expect(r.meetingTitle).toBe("");
    expect(r.attendees).toEqual([]);
    expect(r.actionItems).toEqual([]);
  });
});
