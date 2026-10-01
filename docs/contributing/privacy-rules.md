# Repository privacy rules

This repository is MIT-licensed and world-readable, permanently. **Treat every
artefact as published the moment it is pushed**: source, tests, fixtures,
docs, commit messages, PR titles and bodies, issue text and branch names.

Commit messages and merged PR bodies are the ones people forget. They cannot
be quietly edited later — a force-push rewrites history others may already
have fetched, and a merged PR body is mirrored into notification email the
moment it lands. The scan happens before the commit, never after the merge.

The rules below are short because the WHY is the point; a rule you understand
is one you apply to the case the rule did not foresee.

## Never commit, quote, paste or attach the local ledgers

`runs.jsonl` and its rotation archive, `runs.db` and the run-store mirror,
`run_steps.jsonl`, `outcome-log.jsonl`, `worker_gate_decisions.jsonl`,
`approval_log.jsonl`, the privacy and boundary ledgers, the butler ledgers —
in whole or in excerpt.

They hold real task titles, captured output tails, third-party issue URLs and
external record ids. Several CLI verbs print their contents (`runstore
compare`, `privacy receipts`, `butler shadow --rows`, `privacy undeclared`,
`pr-outcomes show`): that output is real operator data wearing the shape of a
diagnostic blob, and it is not safe to paste into an issue, a PR body or a
fixture.

**Measurements taken from these files are fine; the contents are not.** Cite
"the log retained 18 hours against a 24-hour window", never the rows. The
verbs whose output *is* safe to quote say so in their own description: they
print counts only, never a row, an id or a value.

## Never name a third party or an outside individual

No real third-party organisation names, domains, email addresses, customer
identifiers or account-specific recipe names in code, tests, docs or commit
text. Use neutral placeholders — `noisy-recipe`, `example.test`, `acct-0001`.

A real name already present in the tree is **not** permission to add more. It
is a defect not yet dealt with.

**Connector product names are the deliberate exception.** The vendor ids of
shipped connectors are tool ids in public source — unavoidable, and harmless
alone. What must never appear is a product name *paired with what anyone here
does with it*: who uses it, how often, on what schedule, at what volume.

## Never publish an operational statistic about a named party

"Recipe X is 85% of run volume" discloses two things: a fact about X, and that
we are positioned to measure it. The name may be public; the behaviour is not.

**The measurement is welcome, the attribution is not.** Write "one
high-frequency recipe held 85% of the log" — the engineering point survives,
the disclosure does not. Same rule for counts, volumes, schedules and error
rates.

## Fixtures pull real names in by gravity

Label taxonomies, destination registries, allow/deny lists and their fixtures
attract real-world names — a real vendor is the obvious example to reach for,
and reaching for it is the mistake. **Every example must be synthetic.** A
privacy engine that leaks in its own test data is the sharpest possible own
goal. Worker and errand fixtures follow the same rule: a worker's tasks are
the operator's real errands, so never use a real task title in a fixture, doc
or screenshot.

Policy packs and real-world policy examples do not belong here either, for a
different reason: this repo ships MIT and a published commit cannot be
withdrawn ([ADR-0019](../adr/0019-open-core-boundary.md)).

## Where a sensitive finding goes

A finding whose *disclosure is itself the harm* — "this file exposes X", "this
endpoint leaks Y" — does not go in a public issue, because the issue is the
exploit. It goes to the private operations tracker, or through the security
advisory form in [SECURITY.md](../../SECURITY.md). Do not open a public issue
describing where confidential material is, or was: the pointer is the
disclosure, even when the material itself stays out.

## The gates, and what they cannot do

**A green gate is not a clean scan.** Before every commit, push and PR, read
the diff, the commit text and the branch name yourself. The gates close the
part that can be automated; the rest is you.

### The denylist gate — mechanical, and only as good as your list

`scripts/audit-private-identifiers.mjs` runs from `.husky/pre-commit` (staged
diff and branch name) and `.husky/commit-msg` (the message) and blocks the
commit on a match — the three things people forget.

**The denylist never enters the repository.** Those strings are exactly what
must not be published, so they cannot live in a tracked file. Put your list at
`~/.patchwork/private-identifiers.txt`, outside the repo where `git add -f`
cannot reach it, one string per line. `PATCHWORK_DENYLIST` overrides the path;
a gitignored `.private-denylist` in the repo root also works but is one slip
from being committed, and the gate hard-fails if that file ever becomes
tracked.

Three limits, all deliberate:

1. **It does not run in CI.** CI has no denylist and must not have one. A CI
   step that always reported "not configured" would be noise, and noise is how
   a real warning gets ignored.
2. **With no denylist it announces that it verified nothing and exits 0**,
   rather than blocking a contributor who never configured one. Set
   `PATCHWORK_DENYLIST_REQUIRED=1` to make that state a hard failure. It never
   passes *silently*.
3. **`--no-verify` bypasses it**, and it only protects a machine that has the
   hooks installed. It is a seatbelt, not a wall.

It never prints the matched string — only which denylist entry number matched,
and where. Echoing it would put the secret into scrollback, CI logs and
screenshots, which is the same disclosure one layer over. If the gate blocks
your commit, the message tells you the entry number and the file; fix the
content and commit again.

### The shipped-artifact gate — shape, not knowledge

`scripts/audit-shipped-identifiers.mjs` (CI-gating) scans `templates/` and
`examples/` for identifiers by **shape**: Slack channel ids and
`/Users/<name>` paths. Those directories are distributed — `package.json`'s
`files` includes `templates` wholesale — so a real identifier there is
published *and* copied onto every installer's machine as working
configuration. It was written after a real channel id was found three times in
one shipped example, labelled as three different channels.

It is not a duplicate of the denylist gate: that one needs a secret and so
cannot run in CI and only sees a staged diff; this one needs no secret and so
can. Complements, not overlap. It deliberately does **not** judge domains or
emails — real-versus-placeholder is a knowledge question, not a shape one, and
a guessing gate would either miss the real ones or block legitimate
placeholders. That half stays with the denylist and with reading the diff.

### What the other gates do not see

`scripts/audit-business-content.mjs` reads tracked markdown for commercial
vocabulary. It does not read commit messages, code or tests, and it cannot
recognise a real third-party name used as a neutral-looking identifier.
`scripts/audit-real-ips.mjs` catches a routable IP literal, not a hostname.
[gates.md](gates.md) has the full list.

## A pre-push checklist

- Does the diff contain a real name, domain, email, id or path from a real
  install? Including in a test fixture, a doc example or a screenshot?
- Does the commit message or PR body? The branch name?
- Does anything pair a connector product with what someone does with it?
- Is any number attributed to a named recipe, worker or party?
- Did a CLI verb's output get pasted anywhere? If it names recipes, it is
  operator data.
- Is this finding one where saying where the problem is *is* the problem? Then
  it goes to the private tracker, not the issue.
