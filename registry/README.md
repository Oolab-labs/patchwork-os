# Patchwork OS — Community Recipe Registry

The official registry of Patchwork OS recipes. Browse, install, and contribute automation workflows that connect your tools.

## What is a recipe?

A recipe is a YAML workflow that chains connector actions (Gmail, Linear, Slack, Notion, etc.) and AI agent steps together. Recipes run on the Patchwork OS runtime — no servers to manage.

## Available recipes

| Name | Description | Connectors |
|---|---|---|
| [`@patchworkos/morning-brief`](recipes/morning-brief/) | Daily 6am digest: Gmail, Linear issues, Slack DMs, and today's calendar composed into one Slack message | gmail, linear, slack, googleCalendar |
| [`@patchworkos/incident-war-room`](recipes/incident-war-room/) | Ops incident response: summarize alert, open Linear issue, post to #incidents, log post-incident doc to Notion | linear, slack, notion |
| [`@patchworkos/sprint-review-prep`](recipes/sprint-review-prep/) | Pull completed Linear issues for the sprint, AI-summarize, post digest to #engineering | linear, slack |
| [`@patchworkos/customer-escalation`](recipes/customer-escalation/) | Zendesk ticket escalation: fetch ticket, create linked Linear issue, alert #support-escalations | zendesk, linear, slack |
| [`@patchworkos/deal-won-celebration`](recipes/deal-won-celebration/) | HubSpot deal closed-won: celebrate in #wins Slack, log deal to Notion | hubspot, slack, notion |

## Installing a recipe

```sh
patchwork recipe install github:patchworkos/recipes/recipes/morning-brief
```

This command:
1. Fetches `recipe.json` + all YAML files from the recipe directory
2. Prompts you to fill in required variables
3. Writes config to `~/.patchwork/recipes/<name>/`
4. Registers the recipe in your local runtime

### Installing with variables inline

```sh
patchwork recipe install github:patchworkos/recipes/recipes/morning-brief \
  --var SLACK_CHANNEL=#morning-brief \
  --var LINEAR_TEAM_ID=your-team-id
```

### Listing installed recipes

```sh
patchwork recipe list
```

### Running a recipe manually

```sh
patchwork recipe run @patchworkos/morning-brief
```

### Viewing recipe details before installing

```sh
patchwork recipe info github:patchworkos/recipes/recipes/sprint-review-prep
```

## Browsing recipes

Each recipe lives in its own directory under `recipes/`:

```
recipes/
  <recipe-name>/
    recipe.json     — manifest (name, version, connectors, variables)
    <name>.yaml     — main recipe workflow
    <child>.yaml    — child recipes (if any, for chained workflows)
```

Read `recipe.json` to understand required connectors and variables before installing.

## Recipe format reference

See the [Patchwork OS recipe authoring docs](https://docs.patchworkos.dev/recipes) for the full YAML schema.

Key concepts:
- **`trigger`** — `manual`, `cron`, or `chained` (invoked by a parent recipe)
- **`steps`** — sequential or `parallel` array of tool calls and agent steps
- **`agent`** — AI step with a `prompt`; output referenced in later steps via `{{step_id}}`
- **`awaits`** — declare step dependencies; unlocks parallel execution
- **`recipe`** — call a child recipe by name as a step

## Contributing

We welcome recipes for any connector combination. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Quick path:
1. Fork this repo
2. Add your recipe directory under `recipes/<your-recipe-name>/`
3. Include `recipe.json` + at least one YAML file
4. Open a PR — CI validates the manifest and YAML schema

## Machine-readable index

`index.json` at the repo root is updated on every merge to `main`. Tools can fetch it directly:

```
https://raw.githubusercontent.com/patchworkos/recipes/main/index.json
```

## License

All recipes in this registry are MIT licensed unless stated otherwise in `recipe.json`.
