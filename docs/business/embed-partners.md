# Embed Partner Strategy

Internal strategy doc. Audience: founder, BD, first commercial hire.

## Who buys

Patchwork OS as an **embedded agent runtime** inside someone else's product. The buyer is a B2B software vendor whose customers want AI automation but who doesn't want to build the approval/recipe/multi-model layer themselves. Concrete archetypes:

1. **Dev-tool vendors** — a CI/CD company, a code-review SaaS, an observability platform. They want a "run agent on this event" surface without reinventing the harness.
2. **Vertical SaaS** — legal tech, accounting tech, clinical-ops platforms. Their customers ask for "AI that does X" and they need a safe, auditable runtime behind it.
3. **Internal platform teams at F500s** — building an internal AI platform for their devs/analysts. Want to ship in 3 months, not 18. Buy instead of build.
4. **Consultancies / SI firms** — deliver AI automation projects and need a reusable backbone across clients.

## What they get

- **Embed license** — Patchwork OS source + the right to ship it inside their product without MIT attribution in end-user UI (attribution stays in docs/about-box).
- **White-label dashboard** — themeable approval UI, their logo, their domain.
- **SDK surface** — a stable API for registering recipes, routing approvals to their own permission system, hooking into their audit log.
- **Co-developed recipes** — our team builds 3–10 recipes specific to their vertical during onboarding (paid as a services line item).
- **Managed hosting option** — we run the runtime for them on their subdomain; they resell.
- **Support + SLA** — named contact, private Slack, response-time commitments tiered by ACV.
- **Roadmap influence** — quarterly review where top partners name one feature to prioritize.

## Why MIT matters to them

Counterintuitively, MIT is a **sales asset** for embed deals, not a liability:

- **Procurement-friendly.** Legal teams at F500s pre-approve MIT with minimal review. GPL or SSPL triggers 3–6 months of review and often kills the deal.
- **Lock-in reversal.** Buyers fear betting on a closed AI stack that could raise prices or disappear. MIT core = "worst case we fork and self-host" — that makes yes easier.
- **Audit + compliance.** They can read every line, pass it to their security team, run it through SAST. Closed-source runtimes fail this test in regulated verticals (health, finance, gov).
- **Acquisition hedge.** If Oolab Labs gets acquired or folds, the buyer's product doesn't die.

We still sell. The MIT license doesn't give them the **embed license** (white-label, no-attribution, commercial support, co-developed recipes, hosted option). That bundle is what they pay for. MIT is the trust layer that makes the paid bundle closable.

## Revenue model

Four stacked line items; deals typically include 2–4 of them:

1. **Base embed license** — annual, flat. $25k–$150k/yr depending on end-customer count and whether they white-label. This is the floor; pays for core support + IP grant.
2. **Usage / runtime fee** — per-execution or per-approval-event metering, ~$0.01–0.05/event with volume tiers. Scales with their success, not their headcount. Makes renewals easy because growth is visible.
3. **Co-developed recipes** — professional services. $15k–$50k per recipe bundle, 4–8 week engagements. Billed as SOW. Margin ~50%.
4. **Managed hosting** — if they don't want to run it, we do. Cost-plus-margin on infra + 20% management fee. Typical add: $2k–$20k/mo.

Target blended gross margin: 70%+. License and hosting carry the margin; services is break-even-to-modest; usage fee is the growth lever.

## Deal structure

- **Term**: 1–3 years, annual payment, auto-renew with 60-day notice.
- **MFN clauses**: refuse. Will kneecap future pricing.
- **Exclusivity**: only granted for narrow vertical + geography + time-boxed (≤18 months); priced at 3–5x base.
- **Source escrow**: offered for enterprise deals — no cost to us since core is already MIT.
- **Support tiers**: Bronze (email, 2 biz days) included; Silver (Slack, 4hr) +$20k/yr; Gold (pager, 1hr) +$60k/yr.

## MVP ordering

1. Close first 2 design-partner embed deals at deep discount (50–70% off) in exchange for case studies + public logos + product feedback. Target Q2.
2. Standardize the SDK + white-label theming based on what those 2 partners actually need. Cut anything they didn't ask for.
3. Publish a public embed-partner page with pricing anchors once 3 paying customers are live.
4. Build partner portal (license keys, usage dashboard, support ticketing) only after 5 partners exist.

## Risk flags

- **Support tax.** Embed partners generate 5–10x the support load of Pro customers. Price must reflect this.
- **Feature fragmentation.** Each partner wants bespoke features. Policy: bespoke lives in their fork behind a plugin API; only generalizable features merge upstream.
- **CLA discipline.** Every contributor must sign the CLA (see `../../CLA.md`) so we retain the right to offer non-MIT embed licenses cleanly.
