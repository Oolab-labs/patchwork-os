# Example 2: Review and Merge a Pull Request

This walkthrough shows how to use Claude IDE Bridge to do a thorough code review on a GitHub PR — reading the diff, checking for issues, and either approving or requesting changes.

---

## Scenario

A teammate opened a PR. You want Claude to review it for correctness, security, and style, then post a structured review comment.

---

## Prompt to use

```
Please review PR #42 in this repo. Check for:
- Logic errors or off-by-one bugs
- Missing error handling
- Security issues (injection, unvalidated input)
- TypeScript type safety
- Test coverage gaps

Then post a review comment summarising your findings.
```

---

## What the bridge does (tool call sequence)

**Step 1 — List open PRs**
```
githubListPRs({ state: "open" })
```
Returns: PR numbers, titles, authors, base/head branches.

**Step 2 — Read the full diff**
```
githubGetPRDiff({ prNumber: 42 })
```
Returns: unified diff of all changed files.

**Step 3 — Read full file context for changed files**
```
getBufferContent({ filePath: "src/payments/checkout.ts" })
```
Claude reads the full file, not just the diff lines, to understand surrounding context.

**Step 4 — Check diagnostics on changed files**
```
getDiagnostics({ severity: "warning", uri: "src/payments/checkout.ts" })
```
Catches type errors and lint warnings the diff might introduce.

**Step 5 — Check test coverage**
```
getCodeCoverage({})
```
Identifies whether the changed lines are covered by the test suite.

**Step 6 — Post review**
```
githubCreateReview({
  prNumber: 42,
  event: "REQUEST_CHANGES",
  body: "## Review\n\n**Critical:** Missing input validation on `amount` field ..."
})
```

---

## Expected output

Claude posts a structured review to GitHub with sections for critical issues, suggestions, and a summary verdict. You see the review appear in the PR timeline immediately.

---

## Tips

- If the PR is large, ask Claude to focus on specific files: "Only review changes to `src/auth/**`."
- Ask Claude to check the PR against your coding standards by including your `CONTRIBUTING.md` in context first.
- To approve instead: change `event` to `"APPROVE"` in the prompt.
