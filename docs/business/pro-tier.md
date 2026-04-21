# Patchwork OS — Pro Tier Strategy

Internal strategy doc. Not marketing. Audience: founder + early commercial hires.

## Thesis

MIT core stays free forever. Pro tier sells **operational convenience** on top: things that require us to run infrastructure, hold state across devices, or carry a pager. Anything that can be self-hosted trivially stays in the OSS core — we don't cripple open source to sell Pro.

## Tier shape

### Free (MIT, self-host)
Core OS, local recipes, multi-model, approval dashboard, CLI. No account. No telemetry beyond opt-in.

### Pro — Individual ($19–29/mo)
- **Hosted dashboard** at app.patchwork.dev — same approval UI but accessible from phone/other machines.
- **Phone notifications** (push via FCM/APNS or SMS via Twilio) — "Claude wants to run X, approve?"
- **Cloud recipe sync** across devices; private recipe registry.
- **Encrypted state snapshots** (handoff notes, session logs) for cross-device continuity.
- **Usage analytics** — token spend, recipe success rates, failure clustering.

### Team ($49–99/user/mo, 3-seat min)
- Everything in Pro.
- **Team workspaces** — shared recipe library, shared approval policies, audit log.
- **SSO (Google/Okta/Entra)** + RBAC.
- **Centralized LLM billing** — team pays one invoice; per-seat and per-project spend caps.
- **Approval delegation** — senior eng approves on behalf of juniors.

### Managed LLM Hosting (usage-based, +15–25% margin on raw inference)
- We pay Anthropic/OpenAI/etc at enterprise rates, resell with margin.
- Customer gets single invoice + one API to swap models.
- Attractive for teams that don't want to negotiate N vendor contracts.
- This is the line item that scales non-linearly with product adoption.

### Enterprise (custom, $25k+/yr floor)
- Self-hosted Pro (on-prem/VPC) under commercial license (see `license-strategy.md`).
- SLA, private Slack, quarterly reviews.
- Custom recipe development (services revenue; bill as statement of work).
- SOC 2 report, DPA, security questionnaires.

## Cost-to-operate (rough, per active user/mo)

| Component | Cost | Notes |
|---|---|---|
| Hosted dashboard (compute + DB) | $0.50–2 | Postgres + small app server; amortized across users |
| Push notifications | $0.10–0.30 | FCM free, APNS free, SMS ~$0.008/msg |
| State sync (S3 + bandwidth) | $0.10–0.50 | Snapshots are small (KB-MB) |
| LLM passthrough | **customer-variable** | Pure pass-through + margin; not our cost to bear |
| Support load | $2–5 | Email + shared Slack; scales with seniority of issue |
| **Total fixed COGS** | **~$3–8/user/mo** | Target 75%+ gross margin on Pro sub |

LLM hosting is the wildcard. It's high revenue but low margin (15–25%). Treat it as a complement to the sub, not the anchor.

## MVP ordering

1. **Hosted dashboard + phone push** (Pro individual). This is the single most requested feature from OSS users who tried the local dashboard and wanted it on their phone. Ship first. Prices in 6 months of runway.
2. **Cloud recipe sync**. Low infra cost, high stickiness. Bundle into Pro.
3. **Team workspaces + SSO**. Unlocks 10x ACV per customer. Gate behind 5+ Pro conversions so we know what teams actually ask for.
4. **Managed LLM hosting**. Build only once we have ≥50 Team customers asking; requires contract work with Anthropic for volume pricing.
5. **Enterprise / on-prem**. Reactive. Only build when a signed LOI exists. Charge enough to justify the support tax.

## What stays out of Pro (permanently)

- Core engine, recipes, multi-model routing, approval UI (local), CLI.
- Any file-format or data-portability feature. Customers must always be able to leave.
- Basic telemetry / crash reporting stays opt-in on free; Pro adds depth, not gatekeeping.

## Risk flags

- **Fork risk**: an org clones the MIT core and reimplements Pro. Defense = operational moat (we run it better, faster updates, integrations) + trademark on "Patchwork" (file now).
- **LLM provider margin compression**: if Anthropic launches competing hosted workflows, our LLM resale margin dies. Hedge = never let LLM resale exceed 30% of revenue.
- **Support load on Team tier**: teams file more tickets than individuals. Price must include ~3hr/customer/mo support budget.

## Revisit

Every 6 months, or when: (a) monthly Pro MRR crosses $25k, (b) first enterprise LOI lands, (c) a competitor launches comparable hosted tier.
