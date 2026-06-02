import type { McpTransport } from "../transport.js";
import { successStructured } from "./utils.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

// A matched tool's own input schema is an arbitrary JSON Schema (properties,
// required, nested objects, etc.), so this OUTPUT property is permissive.
// Held in a named const so the strict-input-schema audit (which scans tool
// files for input-schema object literals that must set additionalProperties
// to false) does not misread this permissive output property as a tool input.
const RETURNED_TOOL_INPUT_SCHEMA = {
  type: "object" as const,
  additionalProperties: true as const,
};

export function createSearchToolsTool(transport: McpTransport) {
  return {
    schema: {
      name: "searchTools",
      description:
        "Find tools by keyword/category before tools/list. In --lazy-tools mode, call this first then tools/schema, or set includeSchema:true to return each match's inputSchema inline.",
      annotations: { readOnlyHint: true },
      cache_control: { type: "ephemeral" as const },
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string" as const,
            description: "Keyword to match against tool name and description",
          },
          categories: {
            type: "array" as const,
            description:
              "Filter by categories (e.g. lsp, git, terminal, debug, editor, analysis, github, bridge)",
            items: { type: "string" as const },
          },
          limit: {
            type: "integer" as const,
            description: `Max results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
            minimum: 1,
            maximum: MAX_LIMIT,
          },
          includeSchema: {
            type: "boolean" as const,
            description:
              "Include each matched tool's inputSchema inline so it can be called without a follow-up tools/schema request (default false).",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          tools: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                name: { type: "string" as const },
                description: { type: "string" as const },
                categories: {
                  type: "array" as const,
                  items: { type: "string" as const },
                },
                // Present only when the request set includeSchema:true.
                inputSchema: RETURNED_TOOL_INPUT_SCHEMA,
              },
              required: ["name", "description"],
            },
          },
          totalMatched: { type: "integer" as const },
          query: { type: "string" as const },
          categories: { type: "array" as const },
        },
        required: ["tools", "totalMatched"],
      },
    },

    handler: async (args: Record<string, unknown>) => {
      const query =
        typeof args.query === "string" ? args.query.toLowerCase().trim() : "";
      const filterCategories =
        Array.isArray(args.categories) &&
        args.categories.every((c) => typeof c === "string")
          ? (args.categories as string[]).map((c) => c.toLowerCase())
          : [];
      const limit =
        typeof args.limit === "number"
          ? Math.min(Math.max(1, Math.floor(args.limit)), MAX_LIMIT)
          : DEFAULT_LIMIT;
      const includeSchema = args.includeSchema === true;

      const allSchemas = transport.getToolSchemas();
      const filterCatSet =
        filterCategories.length > 0 ? new Set(filterCategories) : null;

      // Only resolve full input schemas when the caller asks for them — keeps
      // the default response byte-identical to the pre-includeSchema shape.
      const schemaByName = includeSchema
        ? new Map(
            transport
              .getSchemaSnapshot()
              .map((s) => [s.name, s.inputSchema] as const),
          )
        : null;

      const tools: Array<{
        name: string;
        description: string;
        categories?: string[];
        inputSchema?: unknown;
      }> = [];
      let totalMatched = 0;
      for (const t of allSchemas) {
        if (filterCatSet) {
          const cats = t.categories ?? [];
          if (!cats.some((c) => filterCatSet.has(c.toLowerCase()))) continue;
        }
        if (query) {
          if (!`${t.name} ${t.description}`.toLowerCase().includes(query))
            continue;
        }
        totalMatched++;
        if (tools.length < limit) {
          tools.push({
            name: t.name,
            description: t.description,
            ...(t.categories ? { categories: t.categories } : {}),
            ...(schemaByName?.has(t.name)
              ? { inputSchema: schemaByName.get(t.name) }
              : {}),
          });
        }
      }

      return successStructured({
        tools,
        totalMatched,
        ...(query ? { query } : {}),
        ...(filterCategories.length > 0
          ? { categories: filterCategories }
          : {}),
      });
    },
  };
}
