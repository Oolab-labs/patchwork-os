import type { McpTransport } from "../transport.js";
import { successStructured } from "./utils.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export function createSearchToolsTool(transport: McpTransport) {
  return {
    schema: {
      name: "searchTools",
      description:
        "Find tools by keyword or category. Use before tools/list to avoid loading all schemas. In --lazy-tools mode, call this first to find the tool name, then tools/schema for the full schema.",
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
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          tools: { type: "array" as const },
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

      const allSchemas = transport.getToolSchemas();
      const filterCatSet =
        filterCategories.length > 0 ? new Set(filterCategories) : null;

      const tools: Array<{
        name: string;
        description: string;
        categories?: string[];
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
