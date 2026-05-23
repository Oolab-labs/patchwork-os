## Summary

<!-- Brief description of changes -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor
- [ ] CI/config
- [ ] Security-sensitive (env-allowlist / destructive-tier / tools.allow-deny)

## Security-sensitive checklist
<!-- Complete this section if "Security-sensitive" is checked above -->

- [ ] Shadow-run scan output included below (paste SUMMARY block from `patchwork shadow-scan`)
- [ ] Error message matches spec in `documents/error-messages.md`
- [ ] Dashboard banner screenshot attached
- [ ] `audit-env` or equivalent verb run and output included

<details>
<summary>Shadow-scan output</summary>

```
<!-- paste output of: patchwork shadow-scan --since 30d -->
```

</details>

## Test plan

- [ ] Tests added/updated
- [ ] `tsc -p tsconfig.tests.core.json` passes
- [ ] `npm test` passes
