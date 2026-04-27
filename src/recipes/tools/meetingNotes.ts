/**
 * meetingNotes.parse — deterministic parser for Google Meet / Gemini note docs.
 *
 * Accepts the plain-text content of a meeting notes document (or a JSON array
 * of resolved items from the drive.fetchDoc step) and returns structured JSON.
 * No LLM call required — pure regex extraction.
 */

import { registerTool } from "../toolRegistry.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ActionItem {
  assignee: string | null;
  task: string;
}

export interface ParsedMeeting {
  meetingTitle: string;
  meetingDate: string;
  attendees: string[];
  actionItems: ActionItem[];
  decisions: string[];
  openQuestions: string[];
  summaryText: string;
}

// ── Section-heading patterns ──────────────────────────────────────────────────

// Section heading patterns. Accept either Markdown-style (`# Attendees`) or
// bare-line plain-text style (`Attendees` on its own line, optionally with a
// trailing colon) — Google Drive's plain-text export drops `#` prefixes.
const SECTION_PATTERNS: Record<string, RegExp> = {
  attendees:
    /^\s*(?:#+\s*)?(attendees?|participants?|invited|who\s+attended)\s*:?\s*$/im,
  actionItems:
    /^\s*(?:#+\s*)?(action\s+items?|next\s+steps?|suggested\s+next\s+steps?|todos?|follow[\s-]?ups?)\s*:?\s*$/im,
  decisions:
    /^\s*(?:#+\s*)?(decisions?|key\s+decisions?|resolved)\s*:?\s*$/im,
  openQuestions:
    /^\s*(?:#+\s*)?(open\s+questions?|parking\s+lot|unresolved|questions?)\s*:?\s*$/im,
  summary:
    /^\s*(?:#+\s*)?(summary|details|recap|meeting\s+notes?|discussion\s+notes?)\s*:?\s*$/im,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractTitle(text: string): string {
  // First h1 heading
  const h1 = text.match(/^#\s+(.+)$/m);
  if (h1) return h1[1]!.trim();
  // First non-empty line that looks substantive. Skip Gemini boilerplate
  // (e.g. "📝 Notes", "Notes by Gemini") and pick the next real line.
  const lines = text
    .split("\n")
    .map((l) => l.replace(/^[#*\->\s]+/, "").trim())
    .filter((l) => l.length > 3);
  const BOILERPLATE = /^(?:[\p{Emoji_Presentation}\p{Extended_Pictographic}]\s*)?(notes|notes by gemini|meeting notes)\s*$/iu;
  const first = lines.find((l) => !BOILERPLATE.test(l));
  return first ?? lines[0] ?? "";
}

function extractDate(text: string): string {
  // ISO date
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1]!;

  // YYYY/MM/DD (e.g. "2026/04/27" — Gemini-generated doc titles)
  const slash = text.match(/\b(\d{4})\/(\d{1,2})\/(\d{1,2})\b/);
  if (slash) {
    const y = slash[1]!;
    const m = slash[2]!.padStart(2, "0");
    const d = slash[3]!.padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  // Month names: full or 3-letter abbreviation. Handles "Apr 27, 2026" and
  // "27 April 2026" alike.
  const MONTHS =
    "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";

  const human = text.match(
    new RegExp(`\\b(${MONTHS})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, "i"),
  );
  if (human) {
    const month = human[1]!;
    const day = human[2]!.padStart(2, "0");
    const year = human[3]!;
    const mon = new Date(`${month} 1, 2000`).getMonth() + 1;
    return `${year}-${String(mon).padStart(2, "0")}-${day}`;
  }

  const human2 = text.match(
    new RegExp(`\\b(\\d{1,2})\\s+(${MONTHS})\\s+(\\d{4})\\b`, "i"),
  );
  if (human2) {
    const day = human2[1]!.padStart(2, "0");
    const month = human2[2]!;
    const year = human2[3]!;
    const mon = new Date(`${month} 1, 2000`).getMonth() + 1;
    return `${year}-${String(mon).padStart(2, "0")}-${day}`;
  }

  return "";
}

/**
 * Pre-process the doc text so headings that share a line with content are
 * split onto their own line. Gemini Notes exports often render attendee chips
 * inline like `Invited [a@b](mailto:a@b) [c@d](mailto:c@d)` — without this
 * step, splitSections never recognises the heading.
 */
function normalizeInlineHeadings(text: string): string {
  const HEADER_NAMES =
    "attendees?|participants?|invited|attachments?|action\\s+items?|next\\s+steps?|suggested\\s+next\\s+steps?|todos?|follow[\\s-]?ups?|decisions?|key\\s+decisions?|resolved|open\\s+questions?|parking\\s+lot|unresolved|questions?|summary|details|recap|meeting\\s+notes?|discussion\\s+notes?";
  const inlineHeader = new RegExp(
    `^(\\s*(?:#+\\s*)?(?:${HEADER_NAMES}))[\\s:]+(.+)$`,
    "i",
  );
  return text
    .split("\n")
    .map((line) => {
      const m = inlineHeader.exec(line);
      if (!m) return line;
      // Only split if the trailing portion is non-trivial — avoids mangling
      // genuine prose lines that happen to start with a section word.
      const rest = m[2]!.trim();
      if (rest.length === 0) return line;
      return `${m[1]!.trim()}\n${rest}`;
    })
    .join("\n");
}

/**
 * Split doc into named sections. Returns a map of section-name → lines[].
 * Everything before the first recognised heading goes into "preamble".
 */
function splitSections(text: string): Map<string, string[]> {
  const lines = normalizeInlineHeadings(text).split("\n");
  const sections = new Map<string, string[]>();
  sections.set("preamble", []);

  let current = "preamble";
  for (const line of lines) {
    // Drop the standalone `Attachments` block — it's metadata, never content
    // we care about. Both bare and Markdown-link forms are matched.
    if (/^\s*(?:#+\s*)?attachments?\s*:?\s*$/i.test(line)) {
      current = "_drop";
      sections.set("_drop", []);
      continue;
    }
    let matched = false;
    for (const [name, rx] of Object.entries(SECTION_PATTERNS)) {
      if (rx.test(line)) {
        current = name;
        // If the same logical section recurs (e.g. `Summary` followed later
        // by `Details` — both map to "summary"), append rather than reset so
        // earlier content wins for `buildSummary`'s first-3-sentences cutoff.
        if (!sections.has(name)) sections.set(name, []);
        matched = true;
        break;
      }
    }
    if (!matched) {
      sections.get(current)!.push(line);
    }
  }

  sections.delete("_drop");
  return sections;
}

function stripMarkdownInline(s: string): string {
  // Strip ** bold, * / _ italic, and ` inline code markers without touching
  // their content. Keep this lightweight — full Markdown rendering is overkill.
  return s
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?<![*])\*([^*\n]+)\*(?![*])/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1");
}

function bulletLines(lines: string[]): string[] {
  return lines
    // Strip inline Markdown emphasis FIRST. Otherwise the bullet-prefix
    // stripper below would eat leading `**` and leave an orphan trailing `**`.
    .map(stripMarkdownInline)
    // Strip Markdown checkbox markers (`- [ ]`, `* [x]`) before generic
    // bullet-prefix stripping so the checkbox brackets don't survive.
    .map((l) => l.replace(/^[\s\-*•>]+\[[ xX]\]\s*/, ""))
    // Drive's text/plain export renders checkbox bullets as Unicode glyphs
    // (e.g. ☐ ☑ ▢ □ ◯ ✓ ✔). Strip these too so the assignee bracket regex
    // in parseActionItems can match the leading `[Person]` token.
    .map((l) => l.replace(/^\s*[☐☑▢□◯✓✔✗✘]\s*/, ""))
    .map((l) => l.replace(/^[\s\-*•>]+/, "").trim())
    .filter((l) => l.length > 0);
}

/**
 * Extract display names / emails from a line of inline chips. Handles three
 * formats Drive emits across export modes:
 *   1. Markdown link form: `[Stephanie M](mailto:sm@wamae.com)`
 *   2. Tab / 2+ space separated tokens (markdown export of bare chips)
 *   3. Single-space separated tokens with emails as boundaries
 *      (`text/plain` export form): `kwkarago@gmail.com Stephanie M sm@x.com`
 *      where multi-word names are several capitalised tokens in a row.
 */
function extractChips(line: string): string[] {
  const out: string[] = [];

  // 1. Markdown links — pull link text out first, strip from the line.
  const linkRx = /\[([^\]]+)\]\(mailto:[^)]+\)/g;
  let m: RegExpExecArray | null;
  while ((m = linkRx.exec(line)) !== null) {
    out.push(m[1]!.trim());
  }
  let working = line.replace(linkRx, " ");

  // 2. Tab / 2+ space splits — Drive's markdown export between bare chips.
  const wideSplit = working.split(/\t+|\s{2,}/).filter((s) => s.trim());
  if (wideSplit.length > 1) {
    for (const piece of wideSplit) {
      const t = piece.trim();
      if (t.length > 1 && t.length < 100) out.push(t);
    }
    return out;
  }

  // 3. Single-space export form. Tokenise, then walk: emails are atomic;
  // consecutive capitalised tokens are merged into one display name.
  const tokens = working.split(/\s+/).filter(Boolean);
  let nameBuf: string[] = [];
  const flushName = () => {
    if (nameBuf.length === 0) return;
    const name = nameBuf.join(" ").trim();
    if (name.length > 1 && name.length < 100) out.push(name);
    nameBuf = [];
  };
  const isEmail = (t: string) => /@/.test(t);
  // A "name token" starts with a capital letter / is short and alphabetic
  // (handles initials like "M"). Avoid eating section keywords accidentally.
  const isNameToken = (t: string) => /^[A-Z][A-Za-z'.\-]*$/.test(t);

  for (const tok of tokens) {
    if (isEmail(tok)) {
      flushName();
      out.push(tok);
    } else if (isNameToken(tok)) {
      nameBuf.push(tok);
    } else {
      flushName();
    }
  }
  flushName();

  return out;
}

/**
 * Parse action item lines. Supports several Gemini / Meet formats:
 *   `[Person] Title: description`           (escaped or raw brackets)
 *   `[Person 1, Person 2] Title: description`
 *   `Person: task`
 *   plain task lines (assignee=null)
 */
function parseActionItems(lines: string[]): ActionItem[] {
  const UNASSIGNED = /^(unassigned|tbd|n\/a|none|-|the group)$/i;
  return bulletLines(lines).map((line) => {
    // Strip Markdown-escaped brackets that Drive emits (e.g. `\[Stephanie M\]`).
    const cleaned = line.replace(/\\\[/g, "[").replace(/\\\]/g, "]");

    // Form 1: leading `[Person ...] task...`
    const bracket = /^\[([^\]]+)\]\s*(.+)$/.exec(cleaned);
    if (bracket) {
      const assignee = bracket[1]!.trim();
      const task = bracket[2]!.trim();
      return {
        assignee: UNASSIGNED.test(assignee) ? null : assignee,
        task,
      };
    }

    // Form 2: `Person: task` (timestamp-safe — left side must look like a name)
    const colonIdx = cleaned.indexOf(":");
    if (colonIdx > 0 && colonIdx < 40) {
      const left = cleaned.slice(0, colonIdx).trim();
      const right = cleaned.slice(colonIdx + 1).trim();
      if (/^[A-Za-z\s.'-]{2,30}$/.test(left) && right.length > 0) {
        return { assignee: UNASSIGNED.test(left) ? null : left, task: right };
      }
    }
    return { assignee: null, task: cleaned };
  });
}

function buildSummary(sections: Map<string, string[]>): string {
  const body = bulletLines(sections.get("summary") ?? []);
  if (body.length === 0) return "";
  // Return up to 3 sentences joined as prose
  const sentences = body.join(" ").match(/[^.!?]+[.!?]*/g) ?? [];
  return sentences.slice(0, 3).join(" ").trim();
}

// ── Core parser ───────────────────────────────────────────────────────────────

export function parseMeetingNotes(content: string): ParsedMeeting {
  // Drive's plain-text export uses CRLF line endings. Trailing \r on each
  // line breaks every line-anchored section regex (`Invited\r` ≠ `Invited`),
  // so normalise to LF before any pattern matching happens.
  content = content.replace(/\r\n?/g, "\n");
  const sections = splitSections(content);

  const title = extractTitle(content);
  const date = extractDate(
    (sections.get("preamble") ?? []).slice(0, 10).join("\n") + content,
  );

  // Drive's exports render attendee "chips" inline on one line, either as
  // Markdown links (`[Name](mailto:email)`) or as raw tokens separated by
  // tabs / runs of 2+ spaces. extractChips handles both.
  const attendees = bulletLines(sections.get("attendees") ?? [])
    .flatMap(extractChips)
    .filter(
      (a) =>
        a.length > 1 &&
        a.length < 100 &&
        !/^attachments?\s*:?$/i.test(a),
    );

  const actionItems = parseActionItems(sections.get("actionItems") ?? []);
  const decisions = bulletLines(sections.get("decisions") ?? []);
  const openQuestions = bulletLines(sections.get("openQuestions") ?? []);
  const summaryText = buildSummary(sections);

  return {
    meetingTitle: title,
    meetingDate: date,
    attendees,
    actionItems,
    decisions,
    openQuestions,
    summaryText,
  };
}

/**
 * Parse an array of resolved items (from the drive.fetchDoc step) or a raw
 * content string. Input may be:
 *   - JSON array: [{ emailId, subject, source, content }]
 *   - Plain string: raw meeting notes text
 */
function parseInput(raw: string): ParsedMeeting[] {
  const trimmed = raw.trim();

  if (trimmed.startsWith("[")) {
    let items: Array<{ content?: string; emailId?: string }>;
    try {
      items = JSON.parse(trimmed);
    } catch {
      return [parseMeetingNotes(trimmed)];
    }
    return items.map((item) => parseMeetingNotes(item.content ?? ""));
  }

  if (trimmed.startsWith("{")) {
    let obj: { content?: string };
    try {
      obj = JSON.parse(trimmed);
      return [parseMeetingNotes(obj.content ?? trimmed)];
    } catch {
      // fall through
    }
  }

  return [parseMeetingNotes(trimmed)];
}

// ── Team routing helpers ──────────────────────────────────────────────────────

type TeamKey = "Sales" | "Marketing" | "Engineering";

const TEAM_LABELS: Record<TeamKey, string[]> = {
  Sales: ["meeting-action-item", "sales"],
  Marketing: ["meeting-action-item", "marketing"],
  Engineering: ["meeting-action-item", "engineering"],
};

function isUrgentTask(team: TeamKey, task: string): boolean {
  const t = task.toLowerCase();
  if (team === "Sales")
    return /follow.?up|proposal|demo|close date/.test(t);
  if (team === "Marketing")
    return /deadline|launch|campaign/.test(t);
  // Engineering
  return /bug|incident|fix|deploy|urgent/.test(t);
}

function buildTitle(team: TeamKey, meetingTitle: string, task: string): string {
  if (team !== "Sales") return task;
  // Extract company/prospect name from meeting title heuristically:
  // e.g. "Acme Q2 Review" → "[Acme] task"
  const company = meetingTitle.split(/\s+/).slice(0, 2).join(" ").replace(/[^A-Za-z0-9 ]/g, "").trim();
  return company ? `[${company}] ${task}` : task;
}

function buildDescription(
  meeting: ParsedMeeting,
  task: string,
): string {
  const attendees = meeting.attendees.join(", ") || "—";
  return [
    `**Meeting:** ${meeting.meetingTitle} (${meeting.meetingDate})`,
    `**Attendees:** ${attendees}`,
    `**Action item:** ${task}`,
    "",
    "---",
    `**Meeting recap:** ${meeting.summaryText}`,
  ].join("\n");
}

// ── Tool registration ─────────────────────────────────────────────────────────

registerTool({
  id: "meetingNotes.createLinearIssues",
  namespace: "meetingNotes",
  description:
    "For each parsed meeting, create a Linear issue per action item routed to the correct team (Sales / Marketing / Engineering) with team-specific labels, priority, and title rules. Optionally assigns the issue if the action item assignee matches a known Linear user. Returns { created: [{ issueId, identifier, url, task, assignee }] }.",
  paramsSchema: {
    type: "object",
    required: ["meetings", "team"],
    properties: {
      meetings: {
        description:
          "Array of ParsedMeeting objects (output of meetingNotes.parse), or a JSON string of that array.",
      },
      team: {
        type: "string",
        description:
          "Target Linear team for all issues. Accepts the canonical Sales/Marketing/Engineering routing keys (used for label + priority logic) or any team name; falls back to the workspace's first team when no exact match is found in Linear.",
      },
      into: { type: "string" },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      created: {
        type: "array",
        items: {
          type: "object",
          properties: {
            issueId: { type: "string" },
            identifier: { type: "string" },
            url: { type: "string" },
            task: { type: "string" },
            assignee: { type: ["string", "null"] },
          },
        },
      },
      error: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    const { loadTokens, createIssue, updateIssue, listTeams, listLabels } =
      await import("../../connectors/linear.js");

    if (!loadTokens()) {
      return JSON.stringify({ created: [], error: "Linear not connected" });
    }

    const team = String(params.team) as TeamKey;
    const validTeams: TeamKey[] = ["Sales", "Marketing", "Engineering"];
    if (!validTeams.includes(team)) {
      return JSON.stringify({ created: [], error: `Unknown team: ${team}` });
    }

    // Resolve the requested team name to one Linear actually has. The MCP
    // save_issue tool requires an existing team name or ID; if the workspace
    // doesn't name a team literally "Sales"/"Marketing"/"Engineering", every
    // create would otherwise fail. Strategy: case-insensitive exact match,
    // then prefix match, then fall back to the first available team and
    // surface that fallback in the output so /runs makes it visible.
    let resolvedTeam: string = team;
    let teamFallbackNote: string | null = null;
    try {
      const teams = await listTeams();
      if (teams.length === 0) {
        return JSON.stringify({
          created: [],
          error: "Linear workspace has no teams",
        });
      }
      const wanted = team.toLowerCase();
      const exact = teams.find((t) => t.name.toLowerCase() === wanted);
      const prefix = exact ?? teams.find((t) => t.name.toLowerCase().startsWith(wanted));
      const picked = exact ?? prefix ?? teams[0]!;
      resolvedTeam = picked.name;
      if (!exact) {
        teamFallbackNote = `Linear team \"${team}\" not found; used \"${picked.name}\" instead. Available: ${teams.map((t) => t.name).join(", ")}`;
      }
    } catch (err) {
      // listTeams failure is fatal — without team resolution every save_issue
      // call would fail anyway. Surface the underlying error.
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({
        created: [],
        error: `Failed to list Linear teams: ${msg}`,
      });
    }

    // Linear MCP's save_issue rejects label names that don't already exist in
    // the workspace with a generic "Argument Validation Error". Filter the
    // recipe's hardcoded label list down to only those that exist so creates
    // succeed even on workspaces that haven't pre-created our routing labels.
    let allowedLabels: string[] | undefined;
    try {
      const existing = await listLabels();
      const existingNames = new Set(existing.map((l) => l.name.toLowerCase()));
      const wanted = TEAM_LABELS[team] ?? [];
      const filtered = wanted.filter((n) => existingNames.has(n.toLowerCase()));
      allowedLabels = filtered.length > 0 ? filtered : undefined;
    } catch {
      // listLabels failure is non-fatal — fall back to no labels rather than
      // breaking issue creation entirely.
      allowedLabels = undefined;
    }

    let meetings: ParsedMeeting[];
    try {
      const raw = params.meetings;
      meetings = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!Array.isArray(meetings)) meetings = [meetings as ParsedMeeting];
    } catch {
      return JSON.stringify({ created: [], error: "Invalid meetings input" });
    }

    const created: Array<{
      issueId: string;
      identifier: string;
      url: string;
      task: string;
      assignee: string | null;
    }> = [];

    // Surface per-item failures so the recipe can show them downstream.
    // Previously these were swallowed with `continue`, which made silent
    // failures impossible to diagnose.
    const errors: Array<{ task: string; error: string }> = [];

    for (const meeting of meetings) {
      for (const item of meeting.actionItems ?? []) {
        const title = buildTitle(team, meeting.meetingTitle, item.task);
        const priority = isUrgentTask(team, item.task) ? 1 : 2;
        const description = buildDescription(meeting, item.task);

        const issueArgs = {
          team: resolvedTeam,
          title,
          description,
          priority,
          ...(allowedLabels ? { labels: allowedLabels } : {}),
        };

        let result: { id: string; identifier: string; url: string };
        try {
          result = await createIssue(issueArgs);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push({ task: item.task, error: msg });
          continue;
        }

        // Assign if we have a non-null assignee
        if (item.assignee) {
          try {
            await updateIssue({ id: result.identifier, assignee: item.assignee });
          } catch {
            // Assignment failure is non-fatal — issue is already created.
          }
        }

        created.push({
          issueId: result.id,
          identifier: result.identifier,
          url: result.url,
          task: item.task,
          assignee: item.assignee,
        });
      }
    }

    // Top-level error string surfaces the first failure so the calling
    // step's outputTail makes the problem visible without inspecting
    // step output JSON.
    const out: Record<string, unknown> = { created, team: resolvedTeam };
    if (teamFallbackNote) out.warning = teamFallbackNote;
    if (errors.length > 0) {
      out.errors = errors;
      if (created.length === 0) {
        out.error = `All ${errors.length} issue creates failed. First: ${errors[0]!.error}`;
      }
    }
    return JSON.stringify(out);
  },
});

registerTool({
  id: "meetingNotes.parse",
  namespace: "meetingNotes",
  description:
    "Parse Google Meet / Gemini meeting notes plain-text into structured JSON (title, date, attendees, action items, decisions, open questions, summary). Accepts raw text or the JSON array produced by the resolve_content step.",
  paramsSchema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description:
          "Meeting notes plain-text, or JSON array [{emailId,subject,source,content}] from drive.fetchDoc.",
      },
      into: { type: "string" },
    },
    required: ["content"],
  },
  outputSchema: {
    type: "array",
    items: {
      type: "object",
      properties: {
        meetingTitle: { type: "string" },
        meetingDate: { type: "string" },
        attendees: { type: "array", items: { type: "string" } },
        actionItems: {
          type: "array",
          items: {
            type: "object",
            properties: {
              assignee: { type: ["string", "null"] },
              task: { type: "string" },
            },
          },
        },
        decisions: { type: "array", items: { type: "string" } },
        openQuestions: { type: "array", items: { type: "string" } },
        summaryText: { type: "string" },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: false,
  execute: async ({ params }) => {
    const content = String(params.content ?? "");
    const meetings = parseInput(content);
    return JSON.stringify(meetings);
  },
});

// ── meetingNotes.flatten ──────────────────────────────────────────────────────

registerTool({
  id: "meetingNotes.flatten",
  namespace: "meetingNotes",
  description:
    "Extract the first meeting from a ParsedMeeting array and return a flat object ready for Slack template interpolation: { title, date, attendees, summary, decisions, openQuestions, slackChannel }.",
  paramsSchema: {
    type: "object",
    required: ["meetings", "team"],
    properties: {
      meetings: {
        description:
          "Output of meetingNotes.parse — array of ParsedMeeting or JSON string.",
      },
      team: {
        type: "string",
        description:
          "Routing key matching one of Sales/Marketing/Engineering; selects the Slack channel and is forwarded to the Slack template.",
      },
      slackChannelSales: { type: "string", default: "" },
      slackChannelMarketing: { type: "string", default: "" },
      slackChannelEngineering: { type: "string", default: "" },
      issues: {
        description:
          "Optional output of meetingNotes.createLinearIssues, used to render the action-items bullet list for Slack.",
      },
      into: { type: "string" },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      date: { type: "string" },
      attendees: { type: "string" },
      summary: { type: "string" },
      decisions: { type: "string" },
      openQuestions: { type: "string" },
      actionItems: { type: "string" },
      slackChannel: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: false,
  execute: async ({ params }) => {
    let meetings: ParsedMeeting[];
    try {
      const raw = params.meetings;
      meetings = typeof raw === "string" ? JSON.parse(raw as string) : (raw as ParsedMeeting[]);
      if (!Array.isArray(meetings)) meetings = [meetings];
    } catch {
      return JSON.stringify({ error: "Invalid meetings input" });
    }

    const m = meetings[0];
    if (!m) return JSON.stringify({ error: "No meetings found" });

    const team = String(params.team ?? "Engineering");
    const channelMap: Record<string, string> = {
      Sales: String(params.slackChannelSales ?? ""),
      Marketing: String(params.slackChannelMarketing ?? ""),
      Engineering: String(params.slackChannelEngineering ?? ""),
    };

    const toBullets = (arr: string[]): string =>
      arr.length ? arr.map((s) => `• ${s}`).join("\n") : "(none)";

    // Build the Slack-formatted action-items bullet list from the upstream
    // meetingNotes.createLinearIssues output. The recipe template renderer
    // (src/recipes/parser.ts renderTemplate) only supports plain dotted
    // lookups, so per-item formatting must happen here, not in the YAML.
    const issuesRaw = params.issues;
    type CreatedIssue = {
      identifier?: string;
      url?: string;
      task?: string;
      assignee?: string | null;
    };
    let createdIssues: CreatedIssue[] = [];
    let issuesError: string | undefined;
    try {
      const parsed =
        typeof issuesRaw === "string" && issuesRaw.length > 0
          ? JSON.parse(issuesRaw)
          : issuesRaw;
      if (parsed && typeof parsed === "object") {
        const obj = parsed as { created?: unknown; error?: unknown };
        if (Array.isArray(obj.created)) createdIssues = obj.created as CreatedIssue[];
        if (typeof obj.error === "string") issuesError = obj.error;
      }
    } catch {
      // Tolerate missing/invalid issues input — flatten still produces all
      // other Slack fields so the post is useful even when Linear failed.
    }

    const formatIssueBullet = (i: CreatedIssue): string => {
      const task = (i.task ?? "").trim() || "(untitled task)";
      const assignee = i.assignee && i.assignee.length > 0 ? i.assignee : "unassigned";
      if (i.url && i.identifier) {
        return `• <${i.url}|${i.identifier}> ${task} — ${assignee}`;
      }
      if (i.identifier) return `• ${i.identifier} ${task} — ${assignee}`;
      return `• ${task} — ${assignee}`;
    };

    let actionItems: string;
    if (createdIssues.length > 0) {
      actionItems = createdIssues.map(formatIssueBullet).join("\n");
    } else if (issuesError) {
      actionItems = `(Linear create failed: ${issuesError})`;
    } else if ((m.actionItems?.length ?? 0) > 0) {
      // Fallback: render parsed action items even if Linear creation was
      // skipped or returned nothing.
      actionItems = m.actionItems
        .map((a) => `• ${a.task} — ${a.assignee ?? "unassigned"}`)
        .join("\n");
    } else {
      actionItems = "(none)";
    }

    return JSON.stringify({
      title: m.meetingTitle,
      date: m.meetingDate,
      attendees: m.attendees.join(", "),
      summary: m.summaryText,
      decisions: toBullets(m.decisions),
      openQuestions: toBullets(m.openQuestions),
      actionItems,
      slackChannel: channelMap[team] ?? "",
    });
  },
});
