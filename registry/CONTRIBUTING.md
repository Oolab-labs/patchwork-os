# Contributing to the Patchwork OS Recipe Registry

Thank you for contributing. This document covers quality guidelines, local testing, naming conventions, and the PR process.

## Before you start

- Check the existing recipes — avoid duplicating functionality that's already covered
- Read the [recipe authoring docs](https://docs.patchworkos.dev/recipes) for the full YAML schema
- Recipes should work end-to-end with the connectors they declare — test locally before submitting

## Naming conventions

### Namespace

- `@patchworkos/` — reserved for official recipes maintained by the Patchwork OS team
- Community recipes use your own namespace: `@yourname/recipe-name` or `@yourorg/recipe-name`
- Use lowercase, hyphens only (no underscores, no dots): `@acme/deal-won-slack`

### Directory name

Must match the recipe slug (the part after the `/`):

```
recipes/
  deal-won-slack/     <- directory name
    recipe.json       <- name: "@acme/deal-won-slack"
```

## Required files

Every recipe directory must contain:

| File | Required | Description |
|---|---|---|
| `recipe.json` | Yes | Manifest: name, version, connectors, variables, etc. |
| `<name>.yaml` | Yes | Main recipe workflow |
| `<child>.yaml` | If chained | Child recipes referenced in main |

## recipe.json required fields

```json
{
  "name": "@yourname/recipe-name",
  "version": "1.0.0",
  "description": "One clear sentence describing what this recipe does.",
  "author": "yourname",
  "license": "MIT",
  "tags": ["at-least-one-tag"],
  "connectors": ["connector-a", "connector-b"],
  "recipes": {
    "main": "recipe-name.yaml"
  },
  "variables": {},
  "homepage": "https://github.com/patchworkos/recipes/tree/main/recipes/recipe-name"
}
```

All fields above are required. `variables` may be an empty object if the recipe needs none.

### Variable definitions

Every variable your YAML references via `{{VAR_NAME}}` must be declared in `variables`:

```json
"variables": {
  "SLACK_CHANNEL": {
    "description": "Slack channel to post to (e.g. #my-channel)",
    "required": true
  },
  "MAX_RESULTS": {
    "description": "Maximum items to fetch",
    "required": false,
    "default": "10"
  }
}
```

## Recipe quality guidelines

**Clarity**
- Each step should have a single clear purpose
- Use descriptive `id` values: `fetch_ticket`, not `step1`
- Agents prompts should be precise — specify output format when the next step depends on it

**Reliability**
- Set `risk` on every step (`low`, `medium`, `high`)
- Add `on_error` block at recipe level — at minimum set `retry: 0` to make the behavior explicit
- Steps that write data (`postMessage`, `createIssue`, `createPage`) should use `risk: medium` or higher
- Use `optional: true` on steps that can be skipped without breaking downstream steps

**Scope**
- Recipes should do one thing well. If you find yourself chaining 8+ steps in one recipe, consider splitting into parent + child via `trigger: chained`
- Don't hardcode IDs, channel names, or team slugs — expose them as `variables`

**Agent prompts**
- Prompts that return structured data (used by downstream tool steps) must specify the output format: `Return JSON with keys: ...`
- Keep prompts under 500 words. Long prompts indicate unclear scope.

## Testing your recipe locally

### 1. Install your recipe from a local path

```sh
patchwork recipe install ./recipes/my-recipe --dev
```

The `--dev` flag skips the registry lookup and loads directly from disk.

### 2. Run a preflight check

```sh
patchwork recipe preflight ./recipes/my-recipe/my-recipe.yaml
```

Preflight validates YAML structure, checks all referenced connectors are configured, and resolves variable references.

### 3. Dry run

```sh
patchwork recipe run @yourname/my-recipe --dry-run
```

Dry run executes agent steps but skips connector write operations (no Slack posts, no Linear issues created). Useful for testing prompt output.

### 4. Full run with test credentials

```sh
patchwork recipe run @yourname/my-recipe \
  --var SLACK_CHANNEL=#sandbox-test \
  --var LINEAR_TEAM_ID=test-team-id
```

Use sandbox channels / test workspaces for full end-to-end verification.

## Updating index.json

Do NOT manually edit `index.json`. CI regenerates it automatically on merge to `main` from all `recipe.json` files.

## PR checklist

Before opening a pull request:

- [ ] `recipe.json` is present and all required fields are filled in
- [ ] All YAML files are valid (run `patchwork recipe preflight` locally)
- [ ] All variables used in YAML are declared in `recipe.json`
- [ ] Connectors listed in `recipe.json` match what the YAML actually calls
- [ ] Child recipes (if any) are listed in `recipe.json` under `recipes.children`
- [ ] `homepage` URL points to your recipe directory in this repo
- [ ] Description is one sentence, clear enough for someone unfamiliar with your stack
- [ ] No hardcoded secrets, tokens, IDs, or channel names

## PR review process

1. CI runs schema validation + preflight on all changed recipes
2. A maintainer reviews for quality, naming, and scope
3. Approved PRs are merged to `main`; `index.json` is regenerated automatically

## Getting help

Open an issue if you're unsure about a recipe design, need a connector that isn't available yet, or want feedback before writing a full recipe.
