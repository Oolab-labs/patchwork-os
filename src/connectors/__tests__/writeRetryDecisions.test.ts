/**
 * Every connector write has an explicit retry decision (audit M23).
 *
 * `BaseConnector.apiCall` retries a 5xx or network failure twice. For a write
 * that creates or sends something, that is how one message, incident or
 * payment becomes three: the provider may have acted before failing. Such a
 * call passes `nonIdempotent: true` and is retried only on 429/401.
 *
 * This guard makes the decision explicit for every POST / PUT / PATCH that
 * goes through `apiCall` in `src/connectors`: it must either carry
 * `nonIdempotent` or be listed below with the reason a repeat is harmless.
 * A new write that does neither fails here, so the choice cannot be skipped.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Writes deliberately left retryable. Key: `<file>|<path fragment>|<METHOD>`,
 * matched against the request inside the `apiCall` closure.
 */
const REPEAT_IS_HARMLESS: Record<string, string> = {
  "airtable.ts|/v0/{}/{}/{}|PATCH":
    "update by record id; a repeat sets the same fields",
  "airtable.ts|/webhooks/{}/refresh|POST":
    "extends a webhook's expiry; a repeat extends it again",
  "asana.ts|/tasks/{}|PUT": "update by task id",
  "circleci.ts|/workflow/{}/cancel|POST":
    "cancelling a cancelled workflow is a no-op",
  "circleci.ts|/workflow/{}/approve/{}|POST":
    "a second approval of the same job is refused",
  "cloudflare.ts|/dns_records/{}|PATCH": "update by record id",
  "cloudflare.ts|/purge_cache|POST": "purging twice leaves the same state",
  "confluence.ts|/pages/{}|PUT":
    "body and version are fixed before the call; a repeat conflicts on version or rewrites identical content",
  "datadog.ts|/monitor/{}/mute|POST": "muting a muted monitor is a no-op",
  "grafana.ts|/api/ds/query|POST": "read via POST",
  "hubspot.ts|/contacts/search|POST": "read via POST",
  "intercom.ts|/contacts/search|POST": "read via POST",
  "notion.ts|/databases/{}/query|POST": "read via POST",
  "notion.ts|/search|POST": "read via POST",
  "obsidian.ts|/search/simple/|POST": "read via POST",
  "obsidian.ts|/open/{}|POST":
    "opens a note in the editor; a repeat opens the same note",
  "pagerduty.ts|/incidents/{}|PUT": "acknowledge / resolve by incident id",
  "pipedrive.ts|/deals/{}|PUT": "update by deal id",
  "posthog.ts|/query/|POST": "read via POST",
  "supabase.ts|/rest/v1/{}?{}|PATCH": "update by filter",
  "supabase.ts|/rest/v1/{}{}|POST": "upsert (resolution=merge-duplicates)",
  "supabase.ts|/storage/v1/object/{}/{}|POST":
    "upload to an existing path is refused, not duplicated",
  "supabase.ts|/storage/v1/object/list/{}|POST": "read via POST",
  "todoist.ts|/tasks/{}|POST": "update by task id",
  "todoist.ts|/tasks/{}/close|POST": "closing a closed task is a no-op",
  "todoist.ts|/tasks/{}/reopen|POST": "reopening an open task is a no-op",
  "vercel.ts|/cancel|PATCH": "cancelling a cancelled deployment is a no-op",
  "vercel.ts|/env|POST":
    "a duplicate key for the same target is refused, not created twice",
  "zendesk.ts|status|PUT": "status update by ticket id",
};

interface WriteCall {
  file: string;
  line: number;
  methods: string[];
  text: string;
  nonIdempotent: boolean;
}

const dir = join(__dirname, "..");

function writeCalls(): WriteCall[] {
  const out: WriteCall[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(dir, file), "utf8");
    const re = /this\.apiCall\(/g;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      let depth = 0;
      let end = m.index + m[0].length - 1;
      for (; end < src.length; end++) {
        if (src[end] === "(") depth++;
        else if (src[end] === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      const text = src.slice(m.index, end + 1);
      const methods = [...text.matchAll(/method:\s*"(POST|PUT|PATCH)"/g)].map(
        (x) => x[1] as string,
      );
      if (methods.length === 0) continue;
      out.push({
        file,
        line: src.slice(0, m.index).split("\n").length,
        methods,
        text: text.replace(/\$\{[^}]*\}/g, "{}"),
        nonIdempotent: /nonIdempotent:\s*true/.test(text),
      });
    }
  }
  return out;
}

/** The most specific (longest-fragment) entry matching this call. */
function allowlistEntry(c: WriteCall): string | undefined {
  let best: string | undefined;
  let bestLen = -1;
  for (const key of Object.keys(REPEAT_IS_HARMLESS)) {
    const [file, fragment, method] = key.split("|") as [string, string, string];
    if (
      file === c.file &&
      c.methods.includes(method) &&
      c.text.includes(fragment) &&
      fragment.length > bestLen
    ) {
      best = key;
      bestLen = fragment.length;
    }
  }
  return best;
}

describe("connector writes: every retry decision is explicit", () => {
  const calls = writeCalls();

  it("finds the writes it is checking (a guard over nothing fails)", () => {
    expect(calls.length).toBeGreaterThanOrEqual(70);
  });

  for (const c of calls) {
    it(`${c.file}:${c.line} (${c.methods.join("/")}) is nonIdempotent or listed as harmless to repeat`, () => {
      const listed = allowlistEntry(c);
      expect(
        c.nonIdempotent || listed !== undefined,
        "mark it `nonIdempotent: true`, or add it to REPEAT_IS_HARMLESS with the reason a repeat cannot cause a second effect",
      ).toBe(true);
      // Never both: a listed write that is also marked is a stale entry.
      expect(c.nonIdempotent && listed !== undefined).toBe(false);
    });
  }

  it("has no allowlist entry that matches nothing", () => {
    const used = new Set(
      calls.map(allowlistEntry).filter((k): k is string => k !== undefined),
    );
    const stale = Object.keys(REPEAT_IS_HARMLESS).filter((k) => !used.has(k));
    expect(stale).toEqual([]);
  });
});
