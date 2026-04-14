import { successStructured } from "./utils.js";

/**
 * getArchitectureContext — codebase-memory-augmented architectural summary tool.
 *
 * Provides a compact architectural overview by describing what codebase-memory
 * queries to run. This tool acts as a guided prompt for Claude to invoke the
 * codebase-memory MCP tools in sequence and synthesize the results into a
 * structured architectural summary.
 *
 * Designed to be called at session start or via the onInstructionsLoaded hook
 * to give every session architectural grounding without re-deriving it from source.
 */
export function createGetArchitectureContextTool(workspace: string) {
  return {
    schema: {
      name: "getArchitectureContext",
      description:
        "Architectural overview via codebase-memory graph: module boundaries, dependencies, " +
        "ADRs, hotspot files. Returns structured query plan. Requires codebase-memory connected.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          aspects: {
            type: "array" as const,
            items: { type: "string" as const },
            description:
              "Aspects to include: 'modules', 'dependencies', 'adrs', 'hotspots', 'all' (default: ['all'])",
          },
          maxNodes: {
            type: "integer" as const,
            description: "Max graph nodes to return per aspect (default: 20)",
            minimum: 1,
            maximum: 100,
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          workspace: { type: "string" },
          aspects: { type: "array", items: { type: "string" } },
          queries: {
            type: "array",
            items: {
              type: "object",
              properties: {
                aspect: { type: "string" },
                tool: { type: "string" },
                params: { type: "object" },
                description: { type: "string" },
              },
              required: ["aspect", "tool", "params", "description"],
            },
          },
          hint: { type: "string" },
        },
        required: ["workspace", "aspects", "queries", "hint"],
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const aspectsArg = Array.isArray(args.aspects)
        ? (args.aspects as string[])
        : ["all"];
      const maxNodes =
        typeof args.maxNodes === "number"
          ? Math.min(Math.max(args.maxNodes, 1), 100)
          : 20;

      const includeAll = aspectsArg.includes("all");
      const include = (aspect: string) =>
        includeAll || aspectsArg.includes(aspect);

      // Derive project ID from workspace path (mirrors codebase-memory naming convention)
      const projectId = workspace
        .replace(/^\/+/, "")
        .replace(/\//g, "-")
        .replace(/\s+/g, " ");

      const queries: Array<{
        aspect: string;
        tool: string;
        params: Record<string, unknown>;
        description: string;
      }> = [];

      if (include("modules") || include("dependencies")) {
        queries.push({
          aspect: "architecture",
          tool: "mcp__codebase-memory__get_architecture",
          params: {
            project: projectId,
            aspects: ["packages", "services", "dependencies"],
          },
          description:
            "Module boundaries, service topology, and dependency direction",
        });
      }

      if (include("adrs")) {
        queries.push({
          aspect: "adrs",
          tool: "mcp__codebase-memory__manage_adr",
          params: { project: projectId, mode: "list" },
          description:
            "Active Architecture Decision Records — design constraints and rationale",
        });
      }

      if (include("hotspots")) {
        queries.push({
          aspect: "hotspots",
          tool: "mcp__codebase-memory__query_graph",
          params: {
            project: projectId,
            query:
              "MATCH (f:File)-[r:FILE_CHANGES_WITH]-(g:File) RETURN f.path, count(r) as changes ORDER BY changes DESC LIMIT " +
              maxNodes,
          },
          description:
            "Files that frequently change together — high coupling / churn risk",
        });
      }

      if (include("modules")) {
        queries.push({
          aspect: "god-objects",
          tool: "mcp__codebase-memory__query_graph",
          params: {
            project: projectId,
            query:
              "MATCH (n)-[r:CALLS]->(m) WITH m, count(r) as inbound WHERE inbound > 10 RETURN m.name, m.path, inbound ORDER BY inbound DESC LIMIT " +
              maxNodes,
          },
          description: "Highly-called nodes — God objects or core utilities",
        });
      }

      const activeAspects = includeAll
        ? ["architecture", "adrs", "hotspots", "god-objects"]
        : aspectsArg;

      return successStructured({
        workspace,
        aspects: activeAspects,
        queries,
        hint:
          "Run each query in sequence using the specified tool. " +
          "Synthesize results into: (1) module ownership map, " +
          "(2) dependency direction summary, " +
          "(3) active design constraints from ADRs, " +
          "(4) high-risk files to watch. " +
          "If codebase-memory is not indexed, run mcp__codebase-memory__index_repository first.",
      });
    },
  };
}
