# Example 3: Refactor a Module Using LSP

This walkthrough shows how to use Claude IDE Bridge to safely refactor a TypeScript module — renaming symbols, extracting functions, and verifying no regressions — using live LSP data from your editor.

---

## Scenario

You have a `UserService` class that has grown too large. You want to extract payment-related logic into a `PaymentService`, rename an internal helper, and make sure nothing breaks.

---

## Prompt to use

```
I want to refactor src/services/UserService.ts:
1. Find all methods that deal with payments (billing, invoices, subscriptions)
2. Extract them into a new file src/services/PaymentService.ts
3. Update all callers to import from PaymentService instead
4. Rename the internal helper `_calcTotal` to `calculateOrderTotal`
5. Run the tests to confirm nothing is broken
```

---

## What the bridge does (tool call sequence)

**Step 1 — Understand the module structure**
```
getDocumentSymbols({ filePath: "src/services/UserService.ts" })
```
Returns: all classes, methods, and properties with their line ranges.

**Step 2 — Find all callers of payment methods**
```
findReferences({
  filePath: "src/services/UserService.ts",
  line: 84,   // line of processBilling()
  column: 10
})
```
Returns: every file and line that calls `processBilling`.

**Step 3 — Check type signatures before touching anything**
```
getTypeSignature({
  filePath: "src/services/UserService.ts",
  line: 84,
  column: 10
})
```

**Step 4 — Create the new file**
```
createFile({
  filePath: "src/services/PaymentService.ts",
  content: "// extracted from UserService\n..."
})
```

**Step 5 — Remove extracted methods from UserService**
```
replaceBlock({
  filePath: "src/services/UserService.ts",
  oldContent: "  processBilling(...) { ... }",
  newContent: ""
})
```

**Step 6 — Rename the internal helper across the codebase**
```
searchAndReplace({
  pattern: "_calcTotal",
  replacement: "calculateOrderTotal",
  glob: "src/**/*.ts"
})
```

**Step 7 — Verify no type errors**
```
getDiagnostics({ severity: "error" })
```

**Step 8 — Run tests**
```
runTests({})
```

---

## Expected output

Claude creates `PaymentService.ts` with the extracted methods, updates all import statements across the codebase, renames the helper everywhere, confirms zero type errors, and reports a passing test suite.

---

## Tips

- Start with `getDocumentSymbols` before any edits — it gives you the full map of what's in a file so Claude doesn't miss anything.
- For large refactors, ask Claude to do one step at a time and confirm diagnostics are clean before moving to the next.
- Use `getGitDiff` at the end to review everything Claude changed before committing.
- If a rename is risky, ask Claude to use `findReferences` first and list all affected files for your approval.
