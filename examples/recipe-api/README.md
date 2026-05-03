# Recipe API Examples

Call your bridge's recipe API directly — from shell scripts, Node.js
apps, Python scripts, or any HTTP client.

No OAuth required when calling from the same machine as the bridge.
Just grab the bearer token and start calling.

## Get the bearer token

```bash
BRIDGE_TOKEN=$(patchwork print-token)
```

Or read it directly:

```bash
BRIDGE_TOKEN=$(cat ~/.claude/ide/*.lock | jq -r '.authToken' | head -1)
```

For remote deployments, set `--fixed-token <uuid>` at bridge start so
the token doesn't rotate on restart.

## Endpoints at a glance

| Endpoint | Method | What it does |
|----------|--------|-------------|
| `/recipes` | GET | List all installed recipes |
| `/recipes/run` | POST | Run a recipe by name |
| `/runs` | GET | List recent recipe runs (`?limit=N&recipe=name&status=done`) |
| `/runs/:seq` | GET | Fetch one run by sequence number |
| `/approvals` | GET | List pending approval requests |
| `/approvals/:id` | POST | Resolve an approval (`{"decision":"allow"\|"deny"}`) |
| `/approvals/stream` | GET | SSE stream of real-time approval events |
| `/hooks/:path` | POST | Fire a webhook-triggered recipe |

All endpoints require `Authorization: Bearer <token>`.

## Examples

### curl

```bash
# List recipes
curl -s -H "Authorization: Bearer $BRIDGE_TOKEN" http://localhost:3100/recipes | jq '.recipes[].name'

# Run a recipe
curl -s -X POST \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "morning-brief"}' \
  http://localhost:3100/recipes/run | jq .

# Run with variables
curl -s -X POST \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "capture-thought", "vars": {"thought": "Ship dark mode"}}' \
  http://localhost:3100/recipes/run

# Check recent runs
curl -s -H "Authorization: Bearer $BRIDGE_TOKEN" \
  "http://localhost:3100/runs?limit=5" | jq '.[].status'
```

See [curl-examples.sh](curl-examples.sh) for the full script.

### Node.js

```js
const res = await fetch("http://localhost:3100/recipes/run", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.BRIDGE_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ name: "morning-brief" }),
});
const result = await res.json();
```

See [client.mjs](client.mjs) for list, run, poll-until-done, and approval handling.

### Python

```python
import urllib.request, json, os

req = urllib.request.Request(
    "http://localhost:3100/recipes/run",
    data=json.dumps({"name": "morning-brief"}).encode(),
    method="POST",
    headers={
        "Authorization": f"Bearer {os.environ['BRIDGE_TOKEN']}",
        "Content-Type": "application/json",
    },
)
with urllib.request.urlopen(req) as resp:
    print(json.loads(resp.read()))
```

See [client.py](client.py) for the full client with polling and approval handling. No third-party dependencies.

## Building your own app

For a full browser-based app with OAuth (so users authenticate without
sharing your bridge token), see
[`../personal-api-demo/`](../personal-api-demo/) — it implements
dynamic client registration + PKCE S256 against a bridge started with
`--issuer-url`.

For server-side apps that live on the same machine as the bridge, the
bearer token approach above is simpler and sufficient.

## Run a recipe and wait for it to finish

```js
async function runAndWait(name, vars, timeoutMs = 60_000) {
  const { seq } = await bridgeFetch("/recipes/run", {
    method: "POST",
    body: JSON.stringify({ name, vars }),
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const run = await bridgeFetch(`/runs/${seq}`);
    if (run.status === "done") return run;
    if (run.status === "error") throw new Error(run.error);
  }
  throw new Error("Timeout");
}
```

The full Node.js version is in [client.mjs](client.mjs).
