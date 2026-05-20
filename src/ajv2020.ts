/**
 * Shared AJV factory pinned to the JSON Schema 2020-12 dialect.
 *
 * MCP SEP-1613 makes 2020-12 the default dialect. `createAjv2020()`
 * returns an `Ajv2020` instance so any schema with no `$schema` (or an
 * explicit 2020-12 `$schema`) validates as 2020-12 — the spec-aligned
 * default for newly-authored tool and recipe schemas.
 *
 * The draft-07 meta-schema is also registered. ~34 existing tool
 * `inputSchema` objects still declare `$schema: draft-07`; without the
 * meta-schema `Ajv2020.compile()` would throw on them. Registering it
 * keeps every legacy schema compiling unchanged — the dialect upgrade
 * is additive, not a 34-file rewrite. Draft-07 schemas keep draft-07
 * semantics; only bare / 2020-12 schemas get the new default.
 */

import { createRequire } from "node:module";
import type { Options } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";

// JSON can't be `import`ed under NodeNext ESM without an import attribute
// + resolveJsonModule; `createRequire` sidesteps both for this one file.
const require = createRequire(import.meta.url);
const draft7MetaSchema = require("ajv/dist/refs/json-schema-draft-07.json");

/**
 * Construct an `Ajv2020` with the draft-07 meta-schema pre-registered.
 * Drop-in replacement for `new Ajv(opts)` at the bridge's validation
 * sites — accepts the same `Options`.
 */
export function createAjv2020(opts?: Options): Ajv2020 {
  const ajv = new Ajv2020(opts);
  ajv.addMetaSchema(draft7MetaSchema);
  return ajv;
}

export type { ErrorObject, ValidateFunction } from "ajv";
export { Ajv2020 };
