# Vertical: Small Mental-Health Practices

## Why this vertical

- **Regulation pulls toward local models.** HIPAA treats session notes and client identifiers as PHI. Sending them to a hosted LLM requires a Business Associate Agreement, vendor-risk review, and ongoing audit burden that solo and small-group practices cannot absorb. A local-first runtime sidesteps the BAA question entirely — PHI never leaves the device or practice LAN.
- **Documentation pain is universal and quantifiable.** Therapists routinely report 1–2 hours of unpaid "pajama time" per clinical day on notes, insurance correspondence, and intake review. Every minute shaved is a minute of paid capacity recovered or burnout reduced.
- **Stickiness compounds.** Once a practice wires recipes into their intake flow, EHR export, and insurance appeals, switching cost is high. Recipes encode the practice's voice, billing patterns, and risk thresholds — replacing them means re-training the whole workflow.

## Ten starter recipes

1. **Session-note summarizer** — Turn a raw session transcript or dictation into a SOAP/DAP draft for clinician review.
2. **Insurance appeal drafter** — Convert a denial letter + treatment notes into a first-pass appeal citing medical necessity.
3. **No-show follow-up** — Draft a warm, non-punitive outreach message tuned to the client's stage of treatment.
4. **Intake-form triage** — Flag intake responses that need urgent clinician eyes (suicidal ideation, substance acute, minor safety).
5. **Risk-flag detection** — Scan a session note for language patterns that may warrant a safety plan update; suggest, never conclude.
6. **Treatment-plan refresh** — Compare the current plan against recent notes and propose candidate goal updates.
7. **Superbill builder** — Pull CPT codes, dates, and diagnoses from session notes into a client-ready superbill.
8. **Waitlist matcher** — Rank a waitlist against a newly open slot by modality fit, insurance, and stated preferences.
9. **Referral letter** — Draft a clinician-to-clinician referral summary with a configurable disclosure level.
10. **End-of-month billing reconciler** — Cross-check scheduled sessions, notes written, and claims submitted; surface gaps.

All recipes produce drafts a clinician signs off on. None replace clinical judgment.

## Target archetypes

**Solo LCSW / LMFT.** Pays for time back and "feeling less behind." Fears: a vendor breach ending their license; a tool that sounds like someone else; a monthly fee larger than one session. Buys when a peer shows them the session-note recipe working on their own laptop.

**Five-therapist group practice.** Pays for consistency across clinicians, faster insurance AR, and a defensible privacy story for their intake packet. Fears: clinician revolt over "AI notes," an audit finding, onboarding friction. Buys through the practice owner or clinical director; needs an admin console and per-clinician recipe overrides.

**Regional behavioral-health chain (20–100 clinicians).** Pays for measurable reduction in documentation time, insurance-denial turnaround, and a line item their compliance officer can defend. Fears: a pilot that doesn't generalize, integration with their EHR, vendor lock-in. Buys through a procurement process; needs SSO, audit logs, and a named security contact.

## Outreach template

> Subject: 90 minutes back per week, without sending notes to the cloud
>
> Hi [First name],
>
> I build Patchwork, a local AI assistant for small practices. It runs on your own machine — session notes never leave it, so HIPAA stays simple.
>
> Three recipes most practices start with: a SOAP-note drafter from your dictation, an insurance-appeal first draft, and an intake-form triage that flags urgent responses. You review every output; it drafts, you sign.
>
> Would a 15-minute screen-share next week be useful? I'll show it running against a sample note, and if the fit isn't obvious in ten minutes I'll say so.
>
> — [Name]
> [Link to a one-page privacy summary]

## First three users to approach

1. **Solo LCSW, private pay + two insurance panels.** Find via Psychology Today directory filtered by state + "accepting clients" + solo practice; cross-reference LinkedIn for tenure >3 years (stable practice, real documentation volume).
2. **Five-clinician group, owner-operator.** Find via state licensing board rosters joined against group-practice Google Business listings; prioritize owners who post on r/therapists or LinkedIn about admin burden.
3. **Regional chain's clinical-operations lead.** Find via LinkedIn search "director of clinical operations" + "behavioral health" in one target metro; warm intro through a solo or group customer already using Patchwork.

Start with archetype 1. One delighted solo clinician produces the testimonial that unlocks archetype 2.
