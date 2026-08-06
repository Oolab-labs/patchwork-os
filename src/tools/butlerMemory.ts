import type { ButlerFactStore } from "../butler/factStore.js";
import { ORIGINATE_THRESHOLD } from "../butler/types.js";
import { error, requireString, successStructured } from "./utils.js";

/**
 * Butler's durable memory, exposed to agents.
 *
 * The write tool deliberately does NOT take a provenance channel. An agent
 * asking to remember something is, by definition, `recipe_agent` — tier 0.5,
 * STRICTLY below ORIGINATE_THRESHOLD. Letting the caller name its own trust
 * level would hand the pen to whatever text the agent just read, which is the
 * OWASP ASI06 failure mode this store exists to resist.
 *
 * What that tier actually buys, stated precisely because an earlier version of
 * this comment overstated it: a fact written here is DURABLY RECORDED and
 * readable via `butlerRecall({minTrust: 0})`, but it does not become a belief
 * on its own — it is filtered out of `resolveFacts` at the originate floor and
 * never reaches the memory card, so it cannot address the model in a later
 * session's system prompt. It is a proposal with a receipt, not a fact.
 *
 * Promotion to user tier happens only through a human act, outside this
 * surface. There is no reinforcement mechanism yet: two agent-tier rows about
 * the same subject do not combine into something that clears the floor.
 */

export function createButlerRememberTool(store: ButlerFactStore) {
  return {
    schema: {
      name: "butlerRemember",
      description:
        "Record one durable fact about the user (preference, household, standing context) as subject + predicate + value. Written at agent trust, below the belief threshold: it is stored and auditable but does not become something Butler asserts.",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        type: "object" as const,
        required: ["subject", "predicate", "object"],
        properties: {
          subject: {
            type: "string",
            description:
              'What the fact is about: "user", "household.spouse", "car.volvo".',
            maxLength: 128,
          },
          predicate: {
            type: "string",
            description:
              'Which attribute: "diet.avoid", "timezone", "prefers.meeting_length".',
            maxLength: 128,
          },
          object: {
            type: "string",
            description:
              'The value: "shellfish", "Europe/Lisbon", "30 minutes". May be empty to record an explicit "none".',
            maxLength: 512,
          },
          contentConfidence: {
            type: "number",
            description:
              "0–1. Lower it when the claim is hedged ('might', 'I think'). Defaults to 1.",
            minimum: 0,
            maximum: 1,
          },
          sourceRef: {
            type: "string",
            description:
              "Where the claim came from — message id, run seq, issue ref. The receipt.",
            maxLength: 256,
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          seq: { type: "integer" },
          subject: { type: "string" },
          predicate: { type: "string" },
          trust: { type: "number" },
          willOriginate: { type: "boolean" },
        },
        required: ["seq", "subject", "predicate", "trust", "willOriginate"],
      },
    },
    timeoutMs: 5_000,
    async handler(args: Record<string, unknown>) {
      try {
        const subject = requireString(args, "subject", 128);
        const predicate = requireString(args, "predicate", 128);
        const object = typeof args.object === "string" ? args.object : "";
        const cc = args.contentConfidence;
        if (cc !== undefined && typeof cc !== "number")
          return error("contentConfidence must be a number");
        const sourceRef =
          typeof args.sourceRef === "string" ? args.sourceRef : undefined;

        const fact = store.remember({
          subject,
          predicate,
          object,
          channel: "recipe_agent",
          ...(cc !== undefined && { contentConfidence: cc }),
          ...(sourceRef && { sourceRef }),
        });

        return successStructured({
          seq: fact.seq,
          subject: fact.subject,
          predicate: fact.predicate,
          trust: fact.trust,
          // Honest about what just happened: below the threshold this row is
          // recorded but will not, on its own, become a belief.
          willOriginate: fact.trust >= ORIGINATE_THRESHOLD,
        });
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function createButlerRecallTool(store: ButlerFactStore) {
  return {
    schema: {
      name: "butlerRecall",
      description:
        "Read what Butler currently believes about the user. Returns one value per subject+predicate, already resolved for contradictions and retractions. Filter by subject to narrow.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          subject: {
            type: "string",
            description: "Only facts about this subject.",
            maxLength: 128,
          },
          predicate: {
            type: "string",
            description: "Only this attribute.",
            maxLength: 128,
          },
          minTrust: {
            type: "number",
            description: `Minimum trust. Defaults to ${ORIGINATE_THRESHOLD} — established beliefs only. Pass 0 to include low-trust claims (e.g. anything derived from email or chat content), which should be treated as unverified.`,
            minimum: 0,
            maximum: 1,
          },
          limit: {
            type: "integer",
            description: "Max facts to return (default 50, max 200).",
            minimum: 1,
            maximum: 200,
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          facts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                seq: { type: "integer" },
                subject: { type: "string" },
                predicate: { type: "string" },
                object: { type: "string" },
                trust: { type: "number" },
                channel: { type: "string" },
                recordedAt: { type: "integer" },
              },
              required: ["seq", "subject", "predicate", "object", "trust"],
            },
          },
          count: { type: "integer" },
        },
        required: ["facts", "count"],
      },
    },
    timeoutMs: 5_000,
    async handler(args: Record<string, unknown>) {
      try {
        const subject =
          typeof args.subject === "string" ? args.subject.trim() : undefined;
        const predicate =
          typeof args.predicate === "string"
            ? args.predicate.trim()
            : undefined;
        const minTrust =
          typeof args.minTrust === "number"
            ? args.minTrust
            : ORIGINATE_THRESHOLD;
        const limit =
          typeof args.limit === "number"
            ? Math.min(Math.max(Math.trunc(args.limit), 1), 200)
            : 50;

        let facts = store.recall({ minTrust });
        if (subject) facts = facts.filter((f) => f.subject === subject);
        if (predicate) facts = facts.filter((f) => f.predicate === predicate);

        const out = facts.slice(0, limit).map((f) => ({
          seq: f.seq,
          subject: f.subject,
          predicate: f.predicate,
          object: f.object,
          trust: f.trust,
          channel: f.provenance.channel,
          recordedAt: f.recordedAt,
        }));
        return successStructured({ facts: out, count: out.length });
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function createButlerForgetTool(store: ButlerFactStore) {
  return {
    schema: {
      name: "butlerForget",
      description:
        "Retract a fact by its seq (from butlerRecall). Writes a tombstone — the fact stops being believed, and the original row stays in the log so the history remains auditable.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["seq"],
        properties: {
          seq: {
            type: "integer",
            description:
              "seq of the fact to retract, as returned by butlerRecall.",
            minimum: 1,
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          retracted: { type: "integer" },
          tombstoneSeq: { type: "integer" },
        },
        required: ["retracted", "tombstoneSeq"],
      },
    },
    timeoutMs: 5_000,
    async handler(args: Record<string, unknown>) {
      try {
        const seq = args.seq;
        if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1)
          return error("seq must be a positive integer");
        const tomb = store.forget(seq, "recipe_agent");
        return successStructured({ retracted: seq, tombstoneSeq: tomb.seq });
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
