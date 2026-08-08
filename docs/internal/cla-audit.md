# CLA enforcement audit

**Date:** 2026-08-07 · **Scope:** enforcement only. [CLA.md](../../CLA.md)'s terms
are settled and were not reviewed.

**Report only.** No contributor was contacted and no issue was opened.

---

## Summary

| Question | Answer |
|---|---|
| Was CLA acceptance checked automatically on PRs? | **No.** No workflow, no bot, no branch-protection rule referenced the CLA. |
| Is it now? | **Yes** — `.github/workflows/cla.yml`, added with this audit. |
| Are there contributors whose acceptance cannot be evidenced? | **Effectively none.** See below — the exposure is theoretical, not practical. |
| Does anything need chasing? | **No.** |

The headline: **this repository has had no third-party contributors.** Every
commit in 2,171 is authored by the maintainer under one of two identities, or by
a bot. There is no one to chase, and no contribution whose licensing status is
genuinely in doubt.

---

## Contributor list from git history

Full history, all branches reachable from `main`, as of 2026-08-07.

| Author | Email | Commits | Status |
|---|---|---|---|
| `kungfuk3nnyyy` / `Oolab` | `116789549+kungfuk3nnyyy@users.noreply.github.com` | 2,025 | Maintainer and copyright holder |
| `Oolab` / `root` | `info@massappealdesigns.co.ke` | 102 | Same person, second identity (VPS/root commits) |
| `dependabot[bot]` | `49699333+dependabot[bot]@users.noreply.github.com` | 38 | Bot |
| `github-actions[bot]` | `github-actions[bot]@users.noreply.github.com` | 11 | Bot |

Reproduce with:

```bash
git log --format='%an|%ae' | sort -u
```

No author outside those four identities appears anywhere in history:

```bash
git log --format='%ae' | sort -u \
  | grep -viE "kungfuk3nnyyy|massappealdesigns|dependabot|github-actions"
# (no output)
```

---

## Sign-off coverage

`CLA.md` names `Signed-off-by:` as the mechanism of agreement. Coverage is
close to zero:

| Identity | Commits with `Signed-off-by` | Total |
|---|---|---|
| `116789549+kungfuk3nnyyy@…` | 0 | 2,025 |
| `info@massappealdesigns.co.ke` | 1 | 102 |

(41 commits contain the string somewhere in the body, mostly inside squashed
multi-commit PR descriptions rather than as a trailer on the commit itself.)

**This is not a finding that requires action**, for a reason worth stating
explicitly: the CLA exists to move rights *from a contributor to Oolab Labs*.
The only contributors are Oolab Labs. A copyright holder cannot fail to license
work to themselves, so the absent trailers create no gap in the chain of title.

---

## Where the real risk is

Not in the past — in the future, and sooner than it looks:

1. **`CONTRIBUTING.md` actively solicits AI-agent PRs.** That is a deliberate
   policy with its own rules, and it means the first external contribution is
   likely to arrive from an account whose CLA status nobody checked.
2. **A public MIT repository invites drive-by PRs.** The first one would have
   been merged with no acceptance recorded anywhere.
3. **The CLA's relicensing grant is the load-bearing clause.** Clause 2 grants
   Oolab Labs the right to sublicense and relicense — which is exactly what
   makes the open-core plan in [ADR-0019](../adr/0019-open-core-boundary.md)
   possible. An unagreed contribution in the tree is not a paperwork problem;
   it is a contribution that cannot be moved into a commercial edition, and
   removing it later is far harder than declining it now.

The check added here is cheap insurance against a specific, foreseeable event.

---

## What the check does

`.github/workflows/cla.yml`. A PR passes if **any** of:

1. the author is a bot (`type === 'Bot'` or a `[bot]` suffix);
2. the author is listed in `.github/cla-accepted.txt`;
3. every commit in the PR carries a `Signed-off-by:` trailer.

Two design choices worth recording:

- **Sign-off alone is not required.** The maintainer's 2,025 commits are not
  signed off, so "every commit must be signed off" would fail every PR from the
  copyright holder from the first day. A permanently-red gate is one everyone
  learns to ignore — worse than no gate. Hence the allowlist as an equal path.
- **`pull_request_target` with a base-ref checkout.** The allowlist is read from
  the target branch, never from the PR's own diff. Otherwise a contributor could
  add themselves to the allowlist in the same PR the check is meant to gate.

`.github/cla-accepted.txt` starts with the maintainer only.

---

## Recommendations

| # | Recommendation | Why |
|---|---|---|
| 1 | Make the CLA check a **required** status check in branch protection | The workflow reports; only branch protection makes it binding. This is a repository-settings change and cannot be made from a commit. |
| 2 | Add a line to `CONTRIBUTING.md` pointing at `CLA.md` before the first PR | Currently CLA.md is not linked from CONTRIBUTING.md at all — a first-time contributor has no reason to find it. |
| 3 | Leave the historical sign-off gap alone | Rewriting 2,000 commits to add trailers would change every SHA on a public repository to fix a paperwork question that has no substance. |

> `TODO(owner):` decide on recommendation 1 — it needs a repository-settings
> change (Settings → Branches → require the "CLA acceptance" check), which
> cannot be done from a pull request.

---

## Method

```bash
git rev-list --count HEAD                       # 2171
git log --format='%an|%ae' | sort -u            # distinct identities
git log --author=<email> --oneline | wc -l      # per-identity counts
# per-identity sign-off count: iterate %H, grep the body for a trailer
```

Counts are as of commit `805c2254` on `chore/docs-hygiene-qumo-offrepo`.
