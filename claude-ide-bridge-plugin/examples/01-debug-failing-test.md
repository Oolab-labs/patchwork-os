# Example 1: Debug a Failing Test

This walkthrough shows how to use Claude IDE Bridge to diagnose and fix a failing test end-to-end without leaving your editor.

---

## Scenario

You have a TypeScript project. CI is red. You want Claude to find the failing test, understand why it fails, fix the code, and confirm green.

---

## Prompt to use

```
My tests are failing. Please:
1. Run the test suite and show me what's failing
2. Read the relevant source file and the test file
3. Identify the root cause
4. Fix the source code (not the test)
5. Re-run the tests to confirm they pass
```

---

## What the bridge does (tool call sequence)

**Step 1 — Run tests**
```
runTests({ testFramework: "vitest" })
```
Returns: list of failing test names, error messages, file/line references.

**Step 2 — Read the failing test**
```
getBufferContent({ filePath: "src/__tests__/myModule.test.ts" })
```
Returns: full test file content so Claude understands what's being asserted.

**Step 3 — Read the source under test**
```
getBufferContent({ filePath: "src/myModule.ts" })
```

**Step 4 — Check for type errors**
```
getDiagnostics({ severity: "error", uri: "src/myModule.ts" })
```

**Step 5 — Apply the fix**
```
replaceBlock({
  filePath: "src/myModule.ts",
  oldContent: "// buggy implementation",
  newContent: "// fixed implementation"
})
```

**Step 6 — Confirm green**
```
runTests({ testFramework: "vitest" })
```

---

## Expected output

Claude reports the root cause in plain English, shows the exact diff it applied, and confirms the test suite is now passing with exit code 0.

---

## Tips

- Works with Jest, Vitest, Pytest, Cargo test, and Go test — the bridge auto-detects the framework.
- If the error is cryptic, ask Claude to also call `getDiagnostics` and `getGitDiff` to see recent changes.
- For flaky tests, ask Claude to run the suite 3 times and report consistency.
