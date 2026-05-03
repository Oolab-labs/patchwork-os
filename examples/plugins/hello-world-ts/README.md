# hello-world-ts plugin

Minimal Live Toolsmithing starter — TypeScript variant. One tool, zero
runtime dependencies. The compiled `index.mjs` is committed so you can
run it immediately without building first.

## What it does

Exposes `hw.greet(name, language?)` — returns a greeting string.
Not useful on its own; it's a template to replace with your own typed logic.

## Run it (no build needed)

```bash
# From the repo root:
claude-ide-bridge --full \
  --plugin ./examples/plugins/hello-world-ts \
  --plugin-watch
```

Then ask Claude: *"Call hw.greet with name='World' and language='fr'"*

## Edit → build → reload loop

1. Edit `src/index.ts`.
2. In a terminal: `npm install && npm run dev` (runs `tsc --watch`).
3. TypeScript compiles `src/index.ts` → `index.mjs` on each save.
4. The bridge sees the file change and hot-reloads the plugin (`--plugin-watch`).
5. The same Claude session calls the updated tool — no restart needed.

Pair two terminals for the full loop:
```
Terminal 1: claude-ide-bridge --full --plugin . --plugin-watch
Terminal 2: npm run dev
```

## JavaScript variant

See [`../hello-world/`](../hello-world/) for the same plugin with no
build step — edit `index.mjs` directly and save.

## Next steps

- Replace `hw.greet` with a tool that does something real for you.
- Add npm dependencies in `package.json` and `npm install` them.
- Change `toolNamePrefix` in `claude-ide-bridge-plugin.json` to something meaningful.
- For the full manifest schema and context API: [`documents/plugin-authoring.md`](../../../documents/plugin-authoring.md).
- For the Live Toolsmithing narrative: [`documents/live-toolsmithing.md`](../../../documents/live-toolsmithing.md).
