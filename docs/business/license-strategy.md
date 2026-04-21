# License Strategy — Founder's Reference

Personal reference for the founder. Not for public distribution. Re-read before any licensing decision.

## Current state

- **License**: MIT. See `LICENSE`.
- **Copyright**: contributors retain copyright; Oolab Labs holds a broad license grant via the CLA (see `CLA.md`) including the right to sublicense and relicense under non-MIT terms.
- **CLA signing**: enforced on every PR via DCO trailer (`git commit -s`) or one-time "I agree" comment.

## What can be relicensed

**Anything covered by a signed CLA.** That means:
- All code authored by Oolab Labs employees (work-for-hire).
- All merged community contributions where the author signed off.
- Any vendored dependency we re-wrote ourselves.

We can offer this code under a **commercial/embed license** (non-MIT) to paying partners without removing the MIT version. Dual-licensing is the mechanism.

## What CANNOT be relicensed

- **Third-party MIT/Apache dependencies** — they stay under their original license. We don't own them.
- **GPL / AGPL / LGPL dependencies** — we must never take these in. Would infect our relicensing ability. Reject in review.
- **Contributions without a signed CLA** — if ever merged by accident, must be removed or re-contributed with sign-off before any non-MIT distribution.
- **Pre-CLA contributions** (if any exist from before CLA enforcement) — audit these and get retroactive sign-off or rewrite. Do this before the first commercial deal closes.

## Why MIT stays (for now)

1. **Adoption moat**. MIT is the most frictionless license on the planet. Devs install without reading. F500 legal pre-approves it. GPL and SSPL don't enjoy this.
2. **Embed partners pay BECAUSE of MIT**, not despite it (see `embed-partners.md`). Closing a deal with SSPL core is 3x harder; the buyer fears the license, not the tech.
3. **Community trust**. A mid-game license change (à la Elasticsearch, Redis, HashiCorp) burns years of goodwill and invites a hostile fork. Avoid unless survival demands it.
4. **Fork risk is lower than it looks**. Moat is operational (hosted tier, managed LLMs, partner relationships), not legal. A fork has to rebuild all of that.

## Conditions that would trigger revisiting

Revisit licensing **only** if one or more of:

1. **Hyperscaler hostile-host event** — AWS/GCP/Azure launches a managed Patchwork offering that captures >30% of our target market and we can't compete on price. (Elastic/Mongo scenario.) → consider BSL or SSPL for future versions; old versions stay MIT.
2. **Revenue plateau below break-even** for 4+ consecutive quarters with clear evidence that open-core siphon is the cause (not product-market fit failure, not sales execution).
3. **Acquisition conversation** where the acquirer demands a closed-source path to protect investment. Solvable with dual-license, not full close.
4. **Regulatory pressure** (export control, defense market) that requires closed distribution of some modules. Solution is a closed-source add-on, not a core relicense.

**Not triggers**: competitors forking (expected), a partner asking for closed source (just sell them the embed license), a quarter of slow sales (fix sales first).

## If we ever do change

- Grandfather all existing MIT versions. Never retroactive.
- Give 90 days public notice. Write the blog post.
- Keep a permissive "community edition" even if the main license changes, to preserve adoption funnel.
- Talk to a lawyer **before** announcing, not after.

## Hygiene checklist (quarterly)

- Every PR in last quarter has DCO sign-off. Sample 10 at random.
- No GPL/AGPL/LGPL deps added. Check `package.json` + lock file diff.
- CLA document linked from CONTRIBUTING.md and PR template.
- Trademark on "Patchwork OS" (or alternative name) filed and renewed.
