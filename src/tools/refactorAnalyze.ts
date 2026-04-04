import type { ExtensionClient } from "../extensionClient.js";
import {
  extensionRequired,
  requireInt,
  requireString,
  resolveFilePath,
  successStructured,
} from "./utils.js";

type RiskLevel = "low" | "medium" | "high";

function computeRisk(
  referenceCount: number,
  callerCount: number,
  hasInheritance: boolean,
): RiskLevel {
  if (referenceCount > 20 || callerCount > 10 || hasInheritance) return "high";
  if (referenceCount < 5 && callerCount < 3 && !hasInheritance) return "low";
  return "medium";
}

export function createRefactorAnalyzeTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "refactorAnalyze",
      extensionRequired: true,
      description:
        "Analyze the impact of refactoring a symbol before making changes. " +
        "Checks rename safety, counts references and callers, detects inheritance relationships, " +
        "and returns a risk level (low/medium/high). " +
        "Use this before renameSymbol or other refactoring operations to understand scope of impact. " +
        "Requires the VS Code extension.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string" as const,
            description: "Absolute or workspace-relative file path",
          },
          line: {
            type: "integer" as const,
            description: "1-based line number of the symbol to analyze",
          },
          column: {
            type: "integer" as const,
            description: "1-based column number of the symbol to analyze",
          },
        },
        required: ["filePath", "line", "column"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          canRename: { type: "boolean" },
          renameReason: { anyOf: [{ type: "string" }, { type: "null" }] },
          renamePlaceholder: { anyOf: [{ type: "string" }, { type: "null" }] },
          referenceCount: { type: "integer" },
          callerCount: { type: "integer" },
          hasInheritance: { type: "boolean" },
          risk: { type: "string", enum: ["low", "medium", "high"] },
          summary: { type: "string" },
        },
        required: [
          "canRename",
          "referenceCount",
          "callerCount",
          "hasInheritance",
          "risk",
          "summary",
        ],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("refactorAnalyze", [
          "Use findReferences to count references manually",
          "Use getCallHierarchy to inspect callers",
          "Use getTypeHierarchy to check inheritance",
        ]);
      }
      const filePath = resolveFilePath(
        requireString(args, "filePath"),
        workspace,
      );
      const line = requireInt(args, "line", 1);
      const column = requireInt(args, "column", 1);

      const compositeSignal = AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(15_000),
      ]);

      const [
        prepareResult,
        referencesResult,
        callHierarchyResult,
        typeHierarchyResult,
      ] = await Promise.allSettled([
        extensionClient.prepareRename(filePath, line, column, compositeSignal),
        extensionClient.findReferences(filePath, line, column, compositeSignal),
        extensionClient.getCallHierarchy(
          filePath,
          line,
          column,
          "incoming",
          50,
          compositeSignal,
        ),
        extensionClient.getTypeHierarchy(
          filePath,
          line,
          column,
          undefined,
          undefined,
          compositeSignal,
        ),
      ]);

      // Rename safety
      const prepareData =
        prepareResult.status === "fulfilled" ? prepareResult.value : null;
      const canRename =
        prepareData !== null &&
        typeof prepareData === "object" &&
        (prepareData as Record<string, unknown>).canRename !== false;
      const renameReason =
        prepareData !== null &&
        typeof prepareData === "object" &&
        "reason" in (prepareData as object)
          ? String((prepareData as Record<string, unknown>).reason)
          : null;
      const renamePlaceholder =
        prepareData !== null &&
        typeof prepareData === "object" &&
        "placeholder" in (prepareData as object)
          ? String((prepareData as Record<string, unknown>).placeholder)
          : null;

      // Reference count
      const referencesData =
        referencesResult.status === "fulfilled" ? referencesResult.value : null;
      const referenceCount =
        referencesData !== null &&
        typeof referencesData === "object" &&
        "references" in (referencesData as object)
          ? ((referencesData as Record<string, unknown[]>).references?.length ??
            0)
          : 0;

      // Caller count
      const callHierarchyData =
        callHierarchyResult.status === "fulfilled"
          ? callHierarchyResult.value
          : null;
      const callerCount =
        callHierarchyData !== null &&
        typeof callHierarchyData === "object" &&
        "incoming" in (callHierarchyData as object)
          ? ((callHierarchyData as Record<string, unknown[]>).incoming
              ?.length ?? 0)
          : 0;

      // Inheritance
      const typeHierarchyData =
        typeHierarchyResult.status === "fulfilled"
          ? typeHierarchyResult.value
          : null;
      const hasInheritance =
        typeHierarchyData !== null &&
        typeof typeHierarchyData === "object" &&
        ("supertypes" in (typeHierarchyData as object) ||
          "subtypes" in (typeHierarchyData as object));

      const risk = computeRisk(referenceCount, callerCount, hasInheritance);

      const parts: string[] = [];
      if (!canRename) parts.push("rename not supported");
      parts.push(
        `${referenceCount} reference${referenceCount !== 1 ? "s" : ""}`,
      );
      parts.push(`${callerCount} caller${callerCount !== 1 ? "s" : ""}`);
      if (hasInheritance) parts.push("has inheritance relationships");
      const summary = `Risk: ${risk} — ${parts.join(", ")}.`;

      return successStructured({
        canRename,
        renameReason,
        renamePlaceholder,
        referenceCount,
        callerCount,
        hasInheritance,
        risk,
        summary,
      });
    },
  };
}
