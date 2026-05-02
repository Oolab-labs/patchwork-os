/**
 * sqlite-library — Live Toolsmithing example plugin.
 *
 * Exposes a single tool, `lib.query`, that runs a read-only SQL query
 * against a SQLite database (default: ~/library.sqlite3).
 *
 * Why "read-only": this plugin is meant as a worked example of the
 * write-tools-while-running loop, NOT a SQL admin surface. We refuse
 * any statement other than SELECT/PRAGMA/EXPLAIN at the regex level
 * before the query reaches the DB. Users who want write capability can
 * fork the plugin, change the gate, and reload — that *is* the loop.
 *
 * Dependency: `better-sqlite3`. The plugin imports it lazily so the
 * bridge doesn't blow up at load time if the dep isn't installed yet
 * (a freshly-scaffolded plugin won't have run `npm install`).
 *
 * See documents/live-toolsmithing.md for the narrative tour and
 * documents/plugin-authoring.md for the manifest schema.
 */

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_DB_PATH = path.join(os.homedir(), "library.sqlite3");

// Anchored regex: only SELECT / PRAGMA / EXPLAIN allowed, optionally
// preceded by whitespace and an SQL comment block. Multi-statement
// queries are rejected by `better-sqlite3.prepare()` itself; we only
// need to gate the leading verb.
const READ_ONLY_VERB =
  /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*(?:SELECT|PRAGMA|EXPLAIN)\b/i;

let cachedDb = null;
let cachedDbPath = null;

async function openDb(dbPath) {
  if (cachedDb && cachedDbPath === dbPath) return cachedDb;
  if (cachedDb) {
    try {
      cachedDb.close();
    } catch {
      /* already closed */
    }
    cachedDb = null;
  }
  if (!existsSync(dbPath)) {
    throw new Error(`SQLite library not found at ${dbPath}`);
  }
  // Lazy import — better-sqlite3 is a native module, only paid for once
  // a query actually runs.
  const { default: Database } = await import("better-sqlite3");
  cachedDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  cachedDbPath = dbPath;
  return cachedDb;
}

export function register(ctx) {
  ctx.logger.info("sqlite-library loaded", { workspace: ctx.workspace });

  return {
    tools: [
      {
        schema: {
          name: "lib_query",
          description:
            "Run a read-only SQL query against a SQLite library catalog. " +
            "Only SELECT, PRAGMA, and EXPLAIN statements are allowed. " +
            "Default DB: ~/library.sqlite3. " +
            "Returns up to 200 rows as JSON.",
          inputSchema: {
            type: "object",
            required: ["sql"],
            additionalProperties: false,
            properties: {
              sql: {
                type: "string",
                description: "Read-only SQL statement (SELECT/PRAGMA/EXPLAIN).",
              },
              params: {
                type: "array",
                description:
                  "Bound parameters (positional). Match `?` placeholders in the SQL.",
                items: {
                  oneOf: [
                    { type: "string" },
                    { type: "number" },
                    { type: "boolean" },
                    { type: "null" },
                  ],
                },
                default: [],
              },
              dbPath: {
                type: "string",
                description: `Path to the SQLite file. Defaults to ${DEFAULT_DB_PATH}.`,
              },
              limit: {
                type: "integer",
                description:
                  "Max rows to return (cap: 1000, default: 200). Bound after the query runs — use SQL LIMIT for server-side bounding.",
                minimum: 1,
                maximum: 1000,
                default: 200,
              },
            },
          },
          outputSchema: {
            type: "object",
            required: ["rows", "rowCount", "truncated"],
            properties: {
              rows: { type: "array" },
              rowCount: { type: "integer" },
              truncated: { type: "boolean" },
              dbPath: { type: "string" },
            },
          },
          annotations: { readOnlyHint: true },
        },
        handler: async (args /* , signal */) => {
          const sql = String(args.sql ?? "");
          const params = Array.isArray(args.params) ? args.params : [];
          const dbPath =
            typeof args.dbPath === "string" && args.dbPath.length > 0
              ? args.dbPath
              : DEFAULT_DB_PATH;
          const limit = Math.min(Math.max(1, Number(args.limit) || 200), 1000);

          if (!READ_ONLY_VERB.test(sql)) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text:
                    "lib.query rejects non-read statements. Allowed verbs: " +
                    "SELECT, PRAGMA, EXPLAIN. Got: " +
                    sql.slice(0, 80),
                },
              ],
            };
          }

          let db;
          try {
            db = await openDb(dbPath);
          } catch (err) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Failed to open SQLite library: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
            };
          }

          try {
            const stmt = db.prepare(sql);
            const all = stmt.all(...params);
            const rows = all.slice(0, limit);
            const truncated = all.length > limit;
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    rows,
                    rowCount: rows.length,
                    truncated,
                    dbPath,
                  }),
                },
              ],
              structuredContent: {
                rows,
                rowCount: rows.length,
                truncated,
                dbPath,
              },
            };
          } catch (err) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `SQL error: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
            };
          }
        },
      },
    ],
  };
}
