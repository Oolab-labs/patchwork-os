# hello-world plugin

Minimal Live Toolsmithing starter. One tool, zero dependencies — the
smallest possible working plugin.

## What it does

Exposes `hw.greet(name, language?)` — returns a greeting string.
Not useful on its own; it's a template to replace with your own logic.

## Run it

```bash
# From the repo root:
claude-ide-bridge --full \
  --plugin ./examples/plugins/hello-world \
  --plugin-watch
```

Then ask Claude: *"Call hw.greet with name='World'"*

## Edit → reload loop

1. Open `index.mjs` and change the handler (add a tool, change the output, call an API).
2. Save the file.
3. The bridge hot-reloads the plugin automatically (`--plugin-watch`).
4. The same Claude session can call the updated tool immediately — no restart.

This is the Live Toolsmithing loop: Claude asks for a capability that
doesn't exist → you write it → it's available in seconds.

## TypeScript variant

See [`../hello-world-ts/`](../hello-world-ts/) for the same plugin with
full TypeScript types, a `tsconfig.json`, and build/dev scripts.

## Next steps

- Replace `hw.greet` with a tool that does something real for you.
- Change `toolNamePrefix` in `claude-ide-bridge-plugin.json` to something meaningful.
- For the full manifest schema and context API: [`documents/plugin-authoring.md`](../../../documents/plugin-authoring.md).
- For the Live Toolsmithing narrative: [`documents/live-toolsmithing.md`](../../../documents/live-toolsmithing.md).
