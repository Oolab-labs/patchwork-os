import type { ExtensionClient } from "../extensionClient.js";
import {
  execSafe,
  optionalBool,
  optionalString,
  successStructured,
} from "./utils.js";

/**
 * screenshotAndAnnotate — Playwright + IDE state composite tool.
 *
 * Correlates what's visible in the browser with what's happening in the IDE:
 * - Returns a structured action plan for capturing a screenshot via Playwright
 * - Fetches current diagnostics and git diff to annotate what code changes
 *   could explain the visual state
 * - Reports the dev server URL derived from workspace scripts if not provided
 *
 * The actual browser screenshot is taken by executing Playwright MCP tools
 * as guided by the returned `playwrightSteps` field.
 */
export function createScreenshotAndAnnotateTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "screenshotAndAnnotate",
      description:
        "Correlate browser state with IDE state: dev server URL, diagnostics, " +
        "git diff summary, and Playwright steps to capture screenshot.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          url: {
            type: "string" as const,
            description:
              "URL to screenshot. If omitted, derived from package.json dev script.",
          },
          waitForSelector: {
            type: "string" as const,
            description:
              "CSS selector to wait for before screenshotting (e.g. '#app')",
          },
          fullPage: {
            type: "boolean" as const,
            description: "Capture full scrollable page (default: false)",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          targetUrl: { anyOf: [{ type: "string" }, { type: "null" }] },
          playwrightSteps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                step: { type: "integer" },
                tool: { type: "string" },
                params: { type: "object" },
                label: { type: "string" },
              },
              required: ["step", "tool", "params", "label"],
            },
          },
          ideState: {
            type: "object",
            properties: {
              errorCount: { type: "integer" },
              warningCount: { type: "integer" },
              changedFiles: { type: "array", items: { type: "string" } },
              diagnosticSummary: { type: "string" },
            },
            required: ["errorCount", "warningCount", "changedFiles"],
          },
          hint: { type: "string" },
        },
        required: ["targetUrl", "playwrightSteps", "ideState"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const explicitUrl = optionalString(args, "url");
      const waitForSelector = optionalString(args, "waitForSelector");
      const fullPage = optionalBool(args, "fullPage") ?? false;

      // Step 1 — derive dev server URL from package.json scripts if not provided
      let targetUrl: string | null = explicitUrl ?? null;
      if (!targetUrl) {
        try {
          const { readFileSync } = await import("node:fs");
          const pkg = JSON.parse(
            readFileSync(`${workspace}/package.json`, "utf-8"),
          ) as { scripts?: Record<string, string> };
          const devScript = pkg.scripts?.dev ?? pkg.scripts?.start ?? "";
          // Common port patterns: --port 3000, -p 5173, PORT=3000
          const portMatch = devScript.match(/(?:--port|-p|PORT=)\s*(\d{4,5})/);
          if (portMatch?.[1]) {
            targetUrl = `http://localhost:${portMatch[1]}`;
          } else if (devScript.includes("vite")) {
            targetUrl = "http://localhost:5173";
          } else if (devScript.includes("next")) {
            targetUrl = "http://localhost:3000";
          } else if (devScript.includes("react-scripts")) {
            targetUrl = "http://localhost:3000";
          }
        } catch {
          // no package.json or parse error — leave targetUrl null
        }
      }

      // Step 2 — gather IDE state in parallel
      const [diagnosticsResult, diffResult] = await Promise.allSettled([
        extensionClient.isConnected()
          ? extensionClient.getDiagnostics(undefined as never).catch(() => null)
          : Promise.resolve(null),
        execSafe("git", ["diff", "--name-only", "HEAD"], {
          cwd: workspace,
          signal,
          timeout: 5_000,
        }),
      ]);

      // Parse diagnostics
      let errorCount = 0;
      let warningCount = 0;
      let diagnosticSummary = "No diagnostics available";

      if (diagnosticsResult.status === "fulfilled" && diagnosticsResult.value) {
        const diags = diagnosticsResult.value;
        const diagArr = Array.isArray(diags)
          ? diags
          : Array.isArray((diags as Record<string, unknown>)?.diagnostics)
            ? ((diags as Record<string, unknown>).diagnostics as Array<
                Record<string, unknown>
              >)
            : [];
        errorCount = diagArr.filter((d) => d.severity === "error").length;
        warningCount = diagArr.filter((d) => d.severity === "warning").length;
        diagnosticSummary =
          errorCount + warningCount === 0
            ? "No errors or warnings"
            : `${errorCount} error(s), ${warningCount} warning(s)`;
      }

      // Parse changed files
      const changedFiles: string[] = [];
      if (
        diffResult.status === "fulfilled" &&
        diffResult.value.exitCode === 0
      ) {
        for (const line of diffResult.value.stdout.split("\n")) {
          const f = line.trim();
          if (f) changedFiles.push(f);
        }
      }

      // Step 3 — build Playwright action plan
      const playwrightSteps: Array<{
        step: number;
        tool: string;
        params: Record<string, unknown>;
        label: string;
      }> = [];

      let stepNum = 1;

      if (targetUrl) {
        playwrightSteps.push({
          step: stepNum++,
          tool: "mcp__playwright__browser_navigate",
          params: { url: targetUrl },
          label: `Navigate to ${targetUrl}`,
        });
      }

      if (waitForSelector) {
        playwrightSteps.push({
          step: stepNum++,
          tool: "mcp__playwright__browser_wait_for",
          params: { selector: waitForSelector },
          label: `Wait for ${waitForSelector} to appear`,
        });
      }

      playwrightSteps.push({
        step: stepNum++,
        tool: "mcp__playwright__browser_take_screenshot",
        params: { type: "png", fullPage },
        label: fullPage
          ? "Capture full-page screenshot"
          : "Capture viewport screenshot",
      });

      playwrightSteps.push({
        step: stepNum++,
        tool: "mcp__playwright__browser_console_messages",
        params: {},
        label: "Collect browser console errors/warnings",
      });

      const changedFilesSummary =
        changedFiles.length > 0
          ? `Changed files: ${changedFiles.slice(0, 5).join(", ")}${changedFiles.length > 5 ? ` (+${changedFiles.length - 5} more)` : ""}`
          : "No uncommitted changes";

      return successStructured({
        targetUrl,
        playwrightSteps,
        ideState: {
          errorCount,
          warningCount,
          changedFiles,
          diagnosticSummary,
        },
        hint:
          `Execute playwrightSteps in order using the Playwright MCP tools. ` +
          `Then correlate screenshot with IDE state: ${diagnosticSummary}. ` +
          `${changedFilesSummary}.`,
      });
    },
  };
}
