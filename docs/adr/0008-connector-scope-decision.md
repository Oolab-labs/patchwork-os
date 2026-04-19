# ADR-0008: Connector Rollout Scope — 4 Weeks, Front Door First

**Status:** Accepted
**Date:** 2026-04-18

## Context

Three parallel reviews (scope/sequencing, security/architecture, UX/product) converged on the same verdict: the proposed 14-week connector plan (9 Tier-1 connectors + therapy vertical + plugin-SDK infra) ships a dev tool, not a product a parent/therapist/small-business owner would install.

Key findings reviewers agreed on independently:

- **Front door not done.** [package.json](../../package.json) is `0.1.0-alpha.0`; there is no published `npx patchwork-os init`. [docs/install-ux-plan.md](../install-ux-plan.md) puts the drop-off at F4–F7 — before any connector could help.
- **No OAuth broker UI.** The 14-week plan assumed `claude-ide-bridge secrets set gmail.token` on the CLI. No parent or therapist will do this.
- **Approval loop demoted.** The phone-push-tap-approve flow is the hero feature in [docs/business/pro-tier.md](../business/pro-tier.md), not one connector among many.
- **Premature abstraction.** RefResolver registry, dynamic TraceType registry, and `PluginContext` schemaVersion bump (1→2) were proposed before any external plugin exists.
- **Tier 4 blast radius.** Plugins run in-process with no sandbox ([src/pluginLoader.ts](../../src/pluginLoader.ts)). Shipping PHI-handling code in the same repo as general-purpose plugins puts HIPAA posture at the mercy of any bug anywhere.
- **Google OAuth verification is a 4–6 week critical path.** The 14-week plan has no slack if review bounces.

## Decision

Ship the **4-week "front door + one recipe"** scope. Defer connector fan-out, the plugin SDK extraction, and the therapy vertical until one recipe runs end-to-end for one non-dev user.

### In scope (weeks 1–4)

- **W1 — Front door.** Publish `patchwork-os@0.2.0-alpha` to npm. Ship `npx patchwork-os init`. Terminal dashboard. 5 local-only recipes (no OAuth, no cloud). Execute T1–T5 from [docs/install-ux-plan.md](../install-ux-plan.md).
- **W2 — Connections page + Gmail.** Dashboard web UI with a Connections tab that owns OAuth flows and token storage. Gmail-only, hardcoded client. Submit Google verification **day 1 of W2** so the 4–6 week clock runs during the rest of the plan. Add dogfood instrumentation from [documents/roadmap.md](../../documents/roadmap.md) items 1–2 in the same week.
- **W3 — Approval loop as first-class product.** QR-pair phone. Pushover first (no App Store review); APNS/FCM deferred to Pro. Approval-card round-trip: phone buzzes → tap approve → action happens.
- **W4 — morning-brief end-to-end.** Google Calendar + Weather (no-auth open-meteo) + Notes (local filesystem) composed against the broker. `examples/recipes/starter-pack/morning-brief.yaml` runs top-to-bottom. Then one developer connector (Sentry, composing with existing `enrichStackTrace`) to prove the extension seam without building registry abstractions.

### Explicitly out of scope (deferred)

- RefResolver registry as a core extension point (inline Sentry + Linear lookup; extract on third duplication).
- Dynamic TraceType registry (keep the literal union).
- `@claude-ide-bridge/plugin-sdk` as a separate package (re-export the pieces one connector actually needs).
- `PluginContext` schemaVersion bump.
- `pw-contacts`, `pw-weather` as standalone plugins (weather is no-auth HTTP; contacts re-derives from Gmail).
- `pw-notes` backend fan-out (Obsidian / Logseq / Apple Notes). Ship filesystem-notes only in W1.
- FCM / APNS push. Pushover is the free-tier answer; Pro-tier push is a separate future plan.
- Linear, GitHub Actions, Jira, PagerDuty, Datadog, Slack, Notion, Stripe, Plaid, 1Password (Tier 3–5).
- **Therapy vertical entirely.** Spin `patchwork-therapy` out to its own repo on its own clock when this plan concludes. HIPAA posture cannot live in the same process as general connectors.

### Non-negotiable architectural guardrails (if any plugin API surface ships)

Even inside the 4-week scope, if work touches the plugin surface:

1. **Secrets are scoped by calling plugin ID** at SDK construction. No global `secrets.get`. Cross-plugin access requires explicit manifest grant. (Review finding H2.)
2. **Ref patterns are manifest-declared and anchored** (`^LIN-\d+$`). No runtime regex registration. Audit-log each dispatch. (Review finding H1.)

These are ~1 day of work now and unfixable once third-party plugins exist.

## Success criteria

The plan ships if, by end of W4:

- A non-dev user can run `npx patchwork-os init`, reach a working dashboard, click "Connect Gmail", pair their phone, and receive a tap-to-approve notification from `morning-brief` the next morning — without editing any config file or invoking any CLI beyond `init`.
- Google OAuth verification is submitted (not necessarily approved).
- At least one external dogfooder (not the author) has completed the flow.

If any of these miss, stop and reassess before adding more connectors.

## Consequences

**Positive.**

- Installable product exists by W1, three weeks earlier than the 14-week plan's first demoable moment.
- Google verification clock runs during the whole plan instead of after it.
- 10 weeks of slack to respond to what real users ask for instead of what the plan guessed.
- HIPAA legal exposure stays in a separate repo with its own BAA scope.

**Negative.**

- Therapy-vertical revenue is pushed out. Accepted — legal review was going to push it past W14 anyway.
- "Platform" narrative weaker at W4 (one connector, not nine). Accepted — one real connector beats nine paper ones.
- If the plugin SDK / RefResolver abstractions are genuinely needed later, they'll be extracted under pressure rather than designed up front. Accepted — extract on the third duplication per project convention.

## References

- Review summary (this conversation): three reviewers, three independent angles, same verdict.
- [docs/install-ux-plan.md](../install-ux-plan.md) — the front-door work this ADR commits to.
- [docs/business/pro-tier.md](../business/pro-tier.md) — approval-loop positioning.
- [docs/verticals/therapy-practices.md](../verticals/therapy-practices.md) — out of scope for this plan, separate repo.
- [documents/roadmap.md](../../documents/roadmap.md) — dogfood items 1–2 pulled into W2.
