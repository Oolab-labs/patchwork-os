# sqlite-library — Live Toolsmithing example

A worked example for [documents/live-toolsmithing.md](../../../documents/live-toolsmithing.md).

Exposes one tool — `lib.query` — that runs read-only SQL against
`~/library.sqlite3` (override with `dbPath`). Only `SELECT`, `PRAGMA`,
and `EXPLAIN` verbs are accepted; multi-statement queries are rejected
by `better-sqlite3.prepare()`.

## Run it

```bash
# 1. Install the SQLite native dep (~30 seconds)
cd examples/plugins/sqlite-library
npm install better-sqlite3

# 2. Start the bridge with this plugin and hot reload
patchwork start-all \
  --plugin "$(pwd)" \
  --plugin-watch
```

The bridge logs:

```
[plugins] loaded patchwork-examples/sqlite-library (1 tool: lib_query)
[plugins] watching .../examples/plugins/sqlite-library for changes
```

## Try it

In any IDE chat, ask:

> "Use lib_query to list the 5 most recent unread books in my library."

Claude calls:

```json
{
  "name": "lib_query",
  "args": {
    "sql": "SELECT title, author FROM books WHERE read = 0 ORDER BY added_at DESC LIMIT 5"
  }
}
```

## Modify it live

Edit [index.mjs](index.mjs), save. The bridge logs:

```
[plugins] sqlite-library changed — re-registering 1 tool
```

The next chat turn sees the new tool definition. No restart, no reconnect.

## Going further

- Add a `lib_search` tool that takes a free-text query and runs a
  full-text-search query against an FTS5 virtual table.
- Add a write-allowed counterpart, `lib_mark_read`, that requires
  approval through the bridge's [delegation policy](../../../documents/platform-docs.md).
- Replace the local SQLite with a Postgres connection string — the
  same `register()` shape works.

See [documents/plugin-authoring.md](../../../documents/plugin-authoring.md)
for the manifest schema, context API, and distribution flow.
