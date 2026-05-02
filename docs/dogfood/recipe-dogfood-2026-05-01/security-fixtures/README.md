# Recipe Security Fixtures

Permanent home for the recipe-runner exploit YAMLs that the 2026-05-01 dogfood
security pass (G2) demonstrated. They were originally written into
`/tmp/dogfood-G2/` by the live exploit run; these copies are here so the
regression tests in `src/recipes/__tests__/` and `src/recipes/tools/__tests__/`
can load them deterministically without depending on `/tmp` cleanup.

Used by:
- `src/recipes/tools/__tests__/file.test.ts` — A-PR1 path-jail regressions
- `src/__tests__/recipeRoutes-vars-validation.test.ts` — HTTP `vars` validation
- `src/commands/__tests__/cli-warns-when-out-of-jail.test.ts` — CLI warn

Pre-staged for A-PR5 (security-fixture promotion). Do not delete.
