import type { McpTransport } from "../transport.js";
import { successStructured } from "./utils.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export function createSearchToolsTool(transport: McpTransport) {
  return {
    schema: {
      name: "searchTools",
      description:
        "Find available tools by keyword or category. Use before browsing tools/list to avoid loading all schemas.",
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

      const matched = allSchemas.filter((t) => {
        // Category filter: if specified, tool must belong to at least one of them
        if (filterCategories.length > 0) {
          const toolCats = (t.categories ?? []).map((c) => c.toLowerCase());
          if (!filterCategories.some((fc) => toolCats.includes(fc))) {
            return false;
          }
        }
        // Keyword filter: match against name or description
        if (query) {
          const haystack = `${t.name} ${t.description}`.toLowerCase();
          if (!haystack.includes(query)) return false;
        }
        return true;
      });

      const tools = matched.slice(0, limit).map((t) => ({
        name: t.name,
        description: t.description,
        ...(t.categories ? { categories: t.categories } : {}),
      }));

      return successStructured({
        tools,
        totalMatched: matched.length,
        ...(query ? { query } : {}),
        ...(filterCategories.length > 0
          ? { categories: filterCategories }
          : {}),
      });
    },
  };
}
