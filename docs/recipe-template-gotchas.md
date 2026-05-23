# Recipe Template Gotchas

A short reference for the template-resolution edges that trip up real recipes.
Compiled from the bugs that have actually bitten on production runs — not
theoretical pitfalls.

## Agent step output binds to `agent_output`, NOT `<step.id>.agent_output`

For tool steps, the output goes into context under the step's `into:` key, and
its sub-fields are addressable via dot-notation:

```yaml
- id: emails
  tool: gmail.search
  query: "..."
  into: emails
# {{emails.count}} and {{emails.messages}} both work
```

For **agent** steps, the output binds to whatever `into:` you set under the
`agent:` block — and **the step `id:` is ignored as a binding key**. The
default `into:` for agent steps is `agent_output`, so without an explicit
`into:`, the output is at `{{agent_output}}` — not `{{<step.id>.agent_output}}`.

✅ Working:

```yaml
- id: summary
  agent:
    driver: claude-code
    into: summary
    prompt: "Summarise..."

- id: post
  tool: slack.post_message
  text: "{{summary}}"   # works
```

❌ Silently empty:

```yaml
- id: summary
  agent:
    driver: claude-code
    prompt: "Summarise..."
  # no into → output binds to agent_output

- id: post
  tool: slack.post_message
  text: "{{summary.agent_output}}"   # renders empty
```

## Dot-notation only works on JSON-emitting steps

`{{x.y}}` walks `ctx[x]` looking for property `y`. The recipe runner
auto-`JSON.parse`s string values along the way, so a tool that returns a JSON
string like `{"count": 3, "messages": [...]}` lets you `{{emails.count}}`.

If the upstream step returns **plain text** (most agent steps do unless you
explicitly prompt for JSON), dot-notation produces an empty string. To make an
agent step composable via dot-notation, prompt it to emit JSON (a fenced
```json block is fine — the runner parses both).

## Step-root templates render on most fields, but not all

Most step-root scalar fields are template-resolved before they reach the tool
(e.g. `query:`, `text:`, `body:`). One that has bitten: `channel:` at the
step root of `slack.post_message` historically resolved through inconsistent
paths and would render empty in some recipe shapes. **Workaround**: if a
templated `channel:` renders empty, hard-code the channel ID for the smoke
test, then file an issue on the renderer.

## `slack.post_message blocks:` is passed verbatim to Slack

`blocks:` is forwarded directly to Slack's Block Kit API. Shorthand like
`{type: "text", text: "..."}` will get Slack to return `invalid_blocks` —
Block Kit requires the full schema (`{type: "section", text: {type:
"mrkdwn", text: "..."}}`).

For most recipes, use `text:` with markdown instead — `*bold*`, line breaks,
and bullet glyphs render fine in Slack and avoid the schema fragility:

```yaml
- id: post
  tool: slack.post_message
  channel: "C…"
  text: |
    *{{team}} debrief: {{meeting.title}}*
    *Date:* {{meeting.date}}
    {{meeting.summary}}
```

## Connector tools assume their connector is wired

Each tool checks `deps.get<Connector>Token` at the top of `execute()`. If the
connector isn't configured (no OAuth, no API key), the tool returns
`{ok: false, error: "<connector> not connected"}` — the recipe step still
reports `status: "ok"` (the tool didn't throw), but downstream `{{...}}`
references will render empty.

Check the bridge's `/connections` endpoint or the dashboard Connections page
before assuming a recipe will succeed end-to-end.

## When in doubt, dump intermediate state to Slack

The fastest debug pattern when a recipe produces nothing:

```yaml
- id: debug
  tool: slack.post_message
  channel: "<your test channel>"
  text: "DEBUG step_x: ```{{step_x}}```"
```

Look at the literal `{{step_x}}` substitution. Common pathologies:
- Substituted as JSON with the data you expect → downstream consumer is the bug.
- Substituted as empty string → template-resolution issue (see sections above).
- Substituted literally (`{{step_x}}` left in the post) → template key doesn't exist in context.
