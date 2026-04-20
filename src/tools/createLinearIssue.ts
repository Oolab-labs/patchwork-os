import {
  createIssue,
  listLabels,
  listTeams,
  loadTokens,
} from "../connectors/linear.js";
import { requireString, successStructured } from "./utils.js";

export function createLinearIssueTool() {
  return {
    schema: {
      name: "createLinearIssue",
      description:
        "Create a new Linear issue. Requires Linear connector connected. Returns the created issue identifier and URL.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: "object" as const,
        required: ["title"],
        properties: {
          title: {
            type: "string",
            description: "Issue title.",
            maxLength: 500,
          },
          description: {
            type: "string",
            description: "Issue description (Markdown).",
            maxLength: 10000,
          },
          teamKey: {
            type: "string",
            description:
              "Team key (e.g. 'ENG'). If omitted, uses the first team in your workspace.",
            maxLength: 50,
          },
          priority: {
            type: "integer",
            description:
              "Priority: 0=no priority, 1=urgent, 2=high, 3=medium, 4=low.",
            minimum: 0,
            maximum: 4,
          },
          labelNames: {
            type: "array",
            description:
              "Label names to attach (must already exist in Linear).",
            items: { type: "string", maxLength: 100 },
            maxItems: 10,
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string" },
          identifier: { type: "string" },
          title: { type: "string" },
          url: { type: "string" },
          state: { type: "string" },
          team: { type: "string" },
          linearConnected: { type: "boolean" },
        },
        required: [
          "id",
          "identifier",
          "title",
          "url",
          "state",
          "team",
          "linearConnected",
        ],
      },
    },
    timeoutMs: 20_000,
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const tokens = loadTokens();
      if (!tokens) {
        return successStructured({
          id: "",
          identifier: "",
          title: "",
          url: "",
          state: "",
          team: "",
          linearConnected: false,
          error:
            "Linear not connected. POST /connections/linear/connect first.",
        });
      }

      const title = requireString(args, "title", 500);
      const description =
        typeof args.description === "string" ? args.description : undefined;
      const teamKeyArg =
        typeof args.teamKey === "string" ? args.teamKey : undefined;
      const priority =
        typeof args.priority === "number" ? args.priority : undefined;
      const labelNames = Array.isArray(args.labelNames)
        ? (args.labelNames as unknown[])
            .filter((l) => typeof l === "string")
            .map(String)
        : [];

      try {
        // Resolve team ID
        const teams = await listTeams(signal);
        if (teams.length === 0) {
          throw new Error("No teams found in Linear workspace.");
        }

        let teamId: string;
        let teamLabel: string;
        if (teamKeyArg) {
          const match = teams.find(
            (t) => t.key.toLowerCase() === teamKeyArg.toLowerCase(),
          );
          if (!match) {
            throw new Error(
              `Team '${teamKeyArg}' not found. Available teams: ${teams.map((t) => t.key).join(", ")}`,
            );
          }
          teamId = match.id;
          teamLabel = `${match.name} (${match.key})`;
        } else {
          const first = teams[0];
          if (!first) throw new Error("No teams found in Linear workspace.");
          teamId = first.id;
          teamLabel = `${first.name} (${first.key})`;
        }

        // Resolve label IDs if provided
        let labelIds: string[] | undefined;
        if (labelNames.length > 0) {
          const allLabels = await listLabels(signal);
          labelIds = labelNames
            .map((name) => {
              const found = allLabels.find(
                (l) => l.name.toLowerCase() === name.toLowerCase(),
              );
              return found?.id;
            })
            .filter((id): id is string => id !== undefined);
        }

        const issue = await createIssue(
          {
            teamId,
            title,
            description,
            priority,
            labelIds: labelIds && labelIds.length > 0 ? labelIds : undefined,
          },
          signal,
        );

        return successStructured({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          url: issue.url,
          state: issue.state.name,
          team: teamLabel,
          linearConnected: true,
        });
      } catch (err) {
        const notConnected =
          err instanceof Error && err.message.includes("not connected");
        return successStructured({
          id: "",
          identifier: "",
          title: "",
          url: "",
          state: "",
          team: "",
          linearConnected: !notConnected,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
