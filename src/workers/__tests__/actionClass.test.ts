import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  classifyActionClass,
  outcomeWeight,
  reachableLevels,
} from "../actionClass.js";

describe("classifyActionClass", () => {
  it("keys a class as domain:reversibility:blastTier", () => {
    expect(classifyActionClass("getGitStatus")).toEqual({
      key: "vcs-read:reversible:low",
      domain: "vcs-read",
      reversibility: "reversible",
      blastTier: "low",
      brandExposed: false,
    });
    expect(classifyActionClass("gitPush").key).toBe(
      "vcs-push:compensable:high",
    );
    expect(classifyActionClass("slackPostMessage").key).toBe(
      "messaging:irreversible:medium",
    );
  });

  it("folds blast-tier into the key so a higher-blast action is a DISTINCT class", () => {
    // routine read vs a high-blast local mutation in the same vcs family
    expect(classifyActionClass("getGitStatus").key).not.toBe(
      classifyActionClass("gitCommit").key,
    );
    expect(classifyActionClass("gitCommit").key).toBe(
      "vcs-local:reversible:high",
    );
  });

  it("treats unknown tools as irreversible (conservative default)", () => {
    const c = classifyActionClass("someBespokePluginTool");
    expect(c.domain).toBe("other");
    expect(c.reversibility).toBe("irreversible");
  });

  it("classifies recipe-tool ids (what RecipeRunLog records) into the right domains", () => {
    expect(classifyActionClass("git.log_since").domain).toBe("vcs-read");
    expect(classifyActionClass("file.write").domain).toBe("fs-write");
    expect(classifyActionClass("github.list_prs").domain).toBe("vcs-read");
    expect(classifyActionClass("slack.post_message").brandExposed).toBe(true);
  });

  it("classifies github.create_issue as issue / compensable / brand-exposed (a graduating risky class)", () => {
    const c = classifyActionClass("github.create_issue");
    expect(c.domain).toBe("issue");
    expect(c.reversibility).toBe("compensable"); // an issue is closeable
    expect(c.brandExposed).toBe(true); // externally visible
    // compensable ⇒ the full ramp is reachable (can earn L4), unlike irreversible
    expect(reachableLevels(c)).toEqual([0, 1, 2, 3, 4]);
  });

  it("resolves github.create_issue blastTier to 'high' WITHOUT the recipe-tool registry (review #1029 MEDIUM)", () => {
    // This test process never imports recipes/tools, so the tier resolver is
    // absent — exactly the `workers shadow` process. The static override must
    // still yield `high`, matching the live gate, so a worker's trust ledger is
    // keyed identically in both processes (no medium/high split).
    const c = classifyActionClass("github.create_issue");
    expect(c.blastTier).toBe("high");
    expect(c.key).toBe("issue:compensable:high");
  });
});

describe("reachableLevels", () => {
  it("irreversible classes skip the safety-net rungs L2/L3", () => {
    expect(reachableLevels(classifyActionClass("runCommand"))).toEqual([
      0, 1, 4,
    ]);
  });

  it("reversible classes can reach every rung", () => {
    expect(reachableLevels(classifyActionClass("editText"))).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });
});

describe("outcomeWeight", () => {
  it("a routine success is low-information (weight 1)", () => {
    expect(outcomeWeight(classifyActionClass("editText"), true)).toBe(1);
    expect(outcomeWeight(classifyActionClass("runCommand"), true)).toBe(1);
  });

  it("a high-blast irreversible failure vastly outweighs a low-blast reversible one", () => {
    const catastrophic = outcomeWeight(
      classifyActionClass("runCommand"), // shell:irreversible:high → 12 * 3
      false,
    );
    const trivial = outcomeWeight(
      classifyActionClass("getGitStatus"), // vcs-read:reversible:low → 2 * 1
      false,
    );
    expect(catastrophic).toBe(36);
    expect(trivial).toBe(2);
    // the anti-grinding guarantee: one catastrophic failure outweighs ~18
    // trivial successes worth of climb
    expect(catastrophic).toBeGreaterThan(trivial * 10);
  });

  it("a brand-exposed failure is weighted heavier than the same class would be internally", () => {
    const slack = classifyActionClass("slackPostMessage"); // messaging → brand-exposed
    expect(slack.brandExposed).toBe(true);
    // messaging:irreversible:medium → 5 × 3 × 1.5 (brand) = 22.5
    expect(outcomeWeight(slack, false)).toBe(22.5);
    // internal tools are not brand-exposed (no multiplier)
    expect(classifyActionClass("runCommand").brandExposed).toBe(false);
    expect(classifyActionClass("editText").brandExposed).toBe(false);
  });
});

describe("magnitude bands (payments)", () => {
  it("separates a small purchase from a large one into distinct classes", () => {
    // The defect: the class key derived from the tool NAME alone, so trust
    // ground out on cheap instances auto-allowed an expensive one.
    const small = classifyActionClass("paystack.charge_authorization", {
      amount: 500, // minor units — 5.00
    });
    const large = classifyActionClass("paystack.charge_authorization", {
      amount: 500_000, // 5,000.00
    });
    expect(small.key).not.toBe(large.key);
    expect(small.domain).toBe("payments");
    expect(large.domain).toBe("payments");
  });

  it("puts a payments tool in the payments domain, not `other`", () => {
    const ac = classifyActionClass("paystack.initiate_transfer", {
      amount: 1000,
    });
    expect(ac.domain).toBe("payments");
    expect(ac.reversibility).toBe("irreversible");
    expect(ac.brandExposed).toBe(true);
  });

  it("bands are stable buckets, not raw amounts — so a class can graduate", () => {
    const a = classifyActionClass("paystack.charge_authorization", {
      amount: 100,
    });
    const b = classifyActionClass("paystack.charge_authorization", {
      amount: 4000,
    });
    expect(a.key).toBe(b.key); // both in the lowest band
  });

  it("omits the band facet for non-value-bearing domains", () => {
    expect(classifyActionClass("gitPush", { amount: 999_999 }).key).toBe(
      "vcs-push:compensable:high",
    );
  });

  it("falls to the widest band when no amount is derivable", () => {
    const unknown = classifyActionClass("paystack.initiate_transfer", {});
    const huge = classifyActionClass("paystack.initiate_transfer", {
      amount: 10_000_000,
    });
    // An unreadable amount must never be cheaper than the most expensive band.
    expect(unknown.key).toBe(huge.key);
  });
});

describe("money movement rates high blast", () => {
  it("does not let the namespaced-verb heuristic rate a charge as an ordinary write", () => {
    // `charge`/`transfer` are not in the read-verb list, so without an explicit
    // override they fell through to the generic "medium" write default — the
    // same tier as editText.
    for (const tool of [
      "paystack.charge_authorization",
      "paystack.initiate_transfer",
      "stripe.create_charge",
      "stripe.create_payment_intent",
    ]) {
      expect(classifyActionClass(tool, { amount: 100 }).blastTier).toBe("high");
    }
  });

  it("weights a failed high-value charge far above a routine success", () => {
    const ac = classifyActionClass("paystack.initiate_transfer", {
      amount: 5_000_00,
    });
    expect(outcomeWeight(ac, true)).toBe(1);
    // high blast × irreversible × brand-exposed
    expect(outcomeWeight(ac, false)).toBe(12 * 3 * 1.5);
  });
});

describe("decision record legibility", () => {
  it("names the band on the decision, not only inside the key string", () => {
    // `gate explain` answers "why was THIS action gated". Leaving magnitude
    // implicit in the key would make an operator parse a string to find the
    // one fact that decided it.
    const ac = classifyActionClass("paystack.charge_authorization", {
      amount: 5_000_00,
    });
    expect(ac.magnitudeBand).toBe("band>500");
    expect(ac.key.endsWith(":band>500")).toBe(true);
  });

  it("leaves the band absent — not undefined-valued — for non-value domains", () => {
    const ac = classifyActionClass("gitPush");
    expect(ac.magnitudeBand).toBeUndefined();
    // Absent in the serialised form: "not applicable", not "we looked and
    // found none".
    expect(Object.hasOwn(JSON.parse(JSON.stringify(ac)), "magnitudeBand")).toBe(
      false,
    );
  });
});

describe("personal task management", () => {
  it("classifies todoist writes as compensable, not irreversible", () => {
    // Every write has a registered inverse (#1268), so the middle ramp rungs
    // are reachable — but it is compensable, never "reversible": undoing is a
    // new action with residue.
    const ac = classifyActionClass("todoist.create_task");
    expect(ac.domain).toBe("tasks");
    expect(ac.reversibility).toBe("compensable");
    expect(reachableLevels(ac)).toEqual([0, 1, 2, 3, 4]);
  });

  it("keeps reads in their own reversible domain", () => {
    expect(classifyActionClass("todoist.list_tasks").reversibility).toBe(
      "reversible",
    );
  });

  it("does not let personal-task trust unlock engineering issues", () => {
    // A to-do list and a public issue tracker have different audiences.
    expect(classifyActionClass("todoist.create_task").key).not.toBe(
      classifyActionClass("github.create_issue").key,
    );
  });

  it("no longer falls through to other:irreversible", () => {
    // Before this, the whole connector surface classified as `other`, which
    // gated correctly but told an operator nothing about what was gated.
    expect(classifyActionClass("todoist.create_task").domain).not.toBe("other");
  });
});

describe("connector reads (#1311 batch 1)", () => {
  // Before this batch, 186 of 211 registered tools had no domain and fell
  // through to `other:irreversible`. That is a safe default — it fails CLOSED —
  // but it had become the common case, and it gated plain read operations
  // behind human approval.

  it("classifies declared reads as reversible so they bypass the gate", () => {
    // Real registered ids, taken from the tool definitions. An earlier draft
    // of this test invented plausible snake_case names that no tool uses; it
    // failed loudly, but a differently-wrong guess would have passed while
    // asserting nothing.
    for (const tool of [
      "stripe.listCharges",
      "stripe.getCustomer",
      "datadog.getMonitor",
      "airtable.list_records",
      "airtable.get_record",
    ]) {
      const ac = classifyActionClass(tool, {});
      expect(ac.reversibility, `${tool} must be reversible`).toBe("reversible");
      expect(ac.domain, `${tool} must not be the catch-all`).not.toBe("other");
    }
  });

  it("gives a camelCase alias the same class as its canonical tool", () => {
    // Registered as `registerTool({ ...canonical, id: "..." })` — the SAME
    // action under a second name. Classifying one and not the other governs
    // half the callers and leaves the rest on the irreversible default.
    expect(classifyActionClass("linear.listIssues", {}).key).toBe(
      classifyActionClass("linear.list_issues", {}).key,
    );
    expect(classifyActionClass("slack.postMessage", {}).key).toBe(
      classifyActionClass("slack.post_message", {}).key,
    );
  });

  it("does NOT quietly reclassify writes", () => {
    // The guard on this batch. Reads are mechanical — `isWrite: false` is
    // declared by the tool, and a read cannot be irreversible. Writes each need
    // a real judgement about whether they can be undone, and loosening is the
    // dangerous direction, so they must stay on the conservative default until
    // reviewed one by one.
    // The three Linear writes this originally named were reviewed in batch 3
    // and now carry a stated inverse, so they moved. The guard itself still
    // holds and is retargeted at writes NOT yet reviewed — including
    // `obsidian.write_note`, which looks like a sibling of the Notion and
    // Confluence page writes batch 3 did loosen but has no version history to
    // restore from.
    for (const tool of [
      "obsidian.write_note",
      "salesforce.create_record",
      "cloudflare.create_dns_record",
      "circleci.trigger_pipeline",
    ]) {
      expect(classifyActionClass(tool, {}).reversibility).toBe("irreversible");
    }
  });
});

describe("irreversible writes get a domain, not a discount (#1311 batch 2)", () => {
  it("keeps reversibility exactly as the catch-all had it", () => {
    // The whole safety argument for this batch. These tools were already
    // irreversible via the `other` default; `messaging` and `db-write` are
    // irreversible too, and blast tier comes from the tool NAME
    // (classifyTool), not from the domain. So nothing about what the gate
    // permits changes — only which bucket the evidence lands in.
    for (const tool of [
      "discord.send_message",
      "telegram.send_message",
      "twilio.send_sms",
      "sendgrid.send_email",
      "resend.send_email",
      "postgres.query",
      "snowflake.execute_query",
    ]) {
      expect(
        classifyActionClass(tool, {}).reversibility,
        `${tool} must stay irreversible`,
      ).toBe("irreversible");
    }
  });

  it("separates sending mail from running SQL", () => {
    // A single `other` bucket could not tell these apart, so evidence from
    // one would have counted toward the other. "May send mail" and "may run
    // arbitrary SQL" are different authorities.
    const mail = classifyActionClass("sendgrid.send_email", {});
    const sql = classifyActionClass("postgres.query", {});
    expect(mail.domain).toBe("messaging");
    expect(sql.domain).toBe("db-write");
    expect(mail.key).not.toBe(sql.key);
  });
});

describe("tracker / docs / support writes (#1311 batch 3)", () => {
  // The per-tool review, as a table. Each row is a claim about the real world
  // — "this act has THIS inverse" — and the test is what stops the claim from
  // drifting away from the mapping later.
  const REVIEWED: Array<[tool: string, key: string, brandExposed: boolean]> = [
    // Inverse: delete/close the issue, revert the field, delete the comment.
    ["jira.create_issue", "issue:compensable:medium", true],
    ["jira.add_comment", "issue:compensable:medium", true],
    ["jira.update_status", "issue:compensable:medium", true],
    ["linear.createIssue", "issue:compensable:medium", true],
    ["linear.updateIssue", "issue:compensable:medium", true],
    ["linear.addComment", "issue:compensable:medium", true],
    ["meetingNotes.createLinearIssues", "issue:compensable:medium", true],
    // Inverse: delete the item / the comment.
    ["asana.add_task_comment", "tasks:compensable:medium", false],
    ["monday.create_item", "tasks:compensable:medium", false],
    // Inverse: delete the page or restore the prior version (page history).
    ["notion.createPage", "docs-write:compensable:medium", false],
    ["notion.appendBlock", "docs-write:compensable:medium", false],
    ["confluence.createPage", "docs-write:compensable:medium", false],
    ["confluence.appendToPage", "docs-write:compensable:medium", false],
    // NO inverse — text was delivered to a customer. Debucketed only.
    ["intercom.replyToConversation", "messaging:irreversible:medium", true],
    ["zendesk.addComment", "messaging:irreversible:medium", true],
    // Inverse: reopen the ticket.
    ["intercom.closeConversation", "support:compensable:medium", true],
    ["zendesk.updateStatus", "support:compensable:medium", true],
  ];

  it.each(REVIEWED)("classifies %s as %s", (tool, key, brandExposed) => {
    const c = classifyActionClass(tool, {});
    expect(c.key).toBe(key);
    expect(c.brandExposed).toBe(brandExposed);
  });

  it("keeps DELIVERING text apart from flipping ticket state", () => {
    // The distinction this batch turns on, and the one most likely to be
    // flattened by a later sweep: within a SINGLE product, replying to a
    // customer is irreversible and closing their ticket is not. If these ever
    // collapse into one class, evidence from harmless status flips would
    // authorise sending mail to customers.
    const reply = classifyActionClass("intercom.replyToConversation", {});
    const close = classifyActionClass("intercom.closeConversation", {});
    expect(reply.reversibility).toBe("irreversible");
    expect(close.reversibility).toBe("compensable");
    expect(reply.key).not.toBe(close.key);
  });

  it("does not loosen the tools it debucketed", () => {
    // Same guard batch 2 carried: these two were already irreversible via the
    // `other` catch-all and must stay that way. Giving them a domain changes
    // which bucket the evidence lands in, nothing about what the gate permits.
    for (const tool of ["intercom.replyToConversation", "zendesk.addComment"]) {
      expect(
        classifyActionClass(tool, {}).reversibility,
        `${tool} must stay irreversible`,
      ).toBe("irreversible");
    }
  });

  it("leaves every tool still on the ratchet unclassified", () => {
    // Makes the ratchet file honest in BOTH directions. Without this the
    // allowlist could quietly list a tool that is in fact classified — an
    // entry that can never be "cleared" because there is nothing to fix — and
    // the audit would still pass, reporting a gap that does not exist.
    const allowlist = JSON.parse(
      readFileSync(
        new URL(
          "../../../scripts/audit-tool-classification-allowlist.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { allow: string[] };
    // Batch 3 asserted this list was non-empty, as a guard against the test
    // passing vacuously. Batch 4 emptied it, and emptiness is now asserted
    // directly by the batch-4 block below — so the vacuity concern is covered
    // there and this test keeps only the invariant that matters: ANY entry
    // that reappears must be genuinely unclassified.
    for (const tool of allowlist.allow) {
      expect(
        classifyActionClass(tool, {}).domain,
        `${tool} is on the ratchet but IS classified — delete its line`,
      ).toBe("other");
    }
  });
});

describe("CRM + infrastructure writes (#1311 batch 4 — the last 17)", () => {
  const DEBUCKETED: Array<[tool: string, domain: string]> = [
    ["airtable.create_record", "crm-write"],
    ["hubspot.createNote", "crm-write"],
    ["pipedrive.create_deal", "crm-write"],
    ["salesforce.create_record", "crm-write"],
    ["pagerduty.create_incident", "incident"],
    ["pagerduty.acknowledge_incident", "incident"],
    ["pagerduty.add_incident_note", "incident"],
    ["pagerduty.resolve_incident", "incident"],
    ["datadog.muteMonitor", "monitoring-control"],
    ["grafana.create_annotation", "telemetry-write"],
    ["posthog.capture_event", "telemetry-write"],
    ["cloudflare.create_dns_record", "infra"],
    ["circleci.trigger_pipeline", "infra"],
    ["supabase.upload_file", "storage-write"],
    ["obsidian.write_note", "storage-write"],
    ["caldiy.cancel_booking", "scheduling"],
    ["outcomes.classify_issues", "trust-evidence"],
  ];

  it.each(DEBUCKETED)("puts %s in the %s domain", (tool, domain) => {
    expect(classifyActionClass(tool, {}).domain).toBe(domain);
  });

  it("loosens NOTHING — every one stays irreversible", () => {
    // The entire safety argument for this batch. These already classified
    // irreversible via the `other` catch-all; each new domain is irreversible
    // too, and blast tier derives from the tool NAME, so what the gate permits
    // is byte-identical before and after. If this test ever goes red, the
    // change under review is a LOOSENING and needs the per-tool argument
    // batch 3 applied to trackers — not a bulk sweep.
    for (const [tool] of DEBUCKETED) {
      expect(
        classifyActionClass(tool, {}).reversibility,
        `${tool} must stay irreversible`,
      ).toBe("irreversible");
    }
  });

  it("keeps muting alerts apart from writing telemetry", () => {
    // Both touch observability; only one makes the system quieter about
    // failure. Sharing a bucket would let annotation-writing evidence
    // authorise alert suppression.
    const mute = classifyActionClass("datadog.muteMonitor", {});
    const annotate = classifyActionClass("grafana.create_annotation", {});
    expect(mute.domain).toBe("monitoring-control");
    expect(annotate.domain).toBe("telemetry-write");
    expect(mute.key).not.toBe(annotate.key);
  });

  it("gives the trust-evidence writer a domain of its own", () => {
    // `outcomes.classify_issues` writes the outcome-log the ramp READS. It
    // must never share a bucket with ordinary world-changing actions, because
    // evidence about it is evidence about the evidence system.
    const c = classifyActionClass("outcomes.classify_issues", {});
    expect(c.domain).toBe("trust-evidence");
    expect(c.reversibility).toBe("irreversible");
    expect(c.key).not.toBe(classifyActionClass("file.write", {}).key);
  });

  it("marks only the externally-visible failures as brand-exposed", () => {
    expect(
      classifyActionClass("cloudflare.create_dns_record", {}).brandExposed,
    ).toBe(true);
    expect(classifyActionClass("caldiy.cancel_booking", {}).brandExposed).toBe(
      true,
    );
    // Internal: embarrassing, not reputational.
    expect(
      classifyActionClass("pagerduty.create_incident", {}).brandExposed,
    ).toBe(false);
    expect(
      classifyActionClass("salesforce.create_record", {}).brandExposed,
    ).toBe(false);
  });

  it("leaves the ratchet EMPTY — every registered tool is now classified", () => {
    const allowlist = JSON.parse(
      readFileSync(
        new URL(
          "../../../scripts/audit-tool-classification-allowlist.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { allow: string[] };
    expect(allowlist.allow).toEqual([]);
  });
});
