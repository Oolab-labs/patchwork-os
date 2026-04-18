import { createBlameResolver } from "./blame-utils.js";
import { runGitStdout } from "./git-utils.js";
import {
  parseStackTrace,
  resolveFrameFile,
  type StackFrame,
} from "./stackTraceParser.js";
import {
  execSafe,
  optionalInt,
  requireString,
  successStructured,
} from "./utils.js";

interface CommitMeta {
  sha: string;
  author: string;
  date: string;
  subject: string;
}

/**
 * Fetch minimal commit metadata for display. Returns `null` if the commit
 * can't be read (unknown sha, shallow clone, git missing).
 */
async function fetchCommitMeta(
  workspace: string,
  sha: string,
  signal?: AbortSignal,
): Promise<CommitMeta | null> {
  try {
    const out = await runGitStdout(
      ["show", "--no-patch", "--format=%H%n%an <%ae>%n%aI%n%s", sha],
      workspace,
      { signal, timeout: 5_000 },
    );
    const [fullSha, author, date, subject] = out.split("\n");
    if (!fullSha) return null;
    return {
      sha: fullSha,
      author: author ?? "",
      date: date ?? "",
      subject: subject ?? "",
    };
  } catch {
    return null;
  }
}

/**
 * Classify overall confidence in the top suspect:
 *   high   — top frame blamed, >=2 frames agree on the same commit
 *   medium — top frame blamed, other frames blamed to different commits
 *   low    — top frame not blamed (outside workspace / uncommitted)
 */
function scoreConfidence(
  topShaResolved: boolean,
  uniqueShas: string[],
  topSha: string | null,
): "high" | "medium" | "low" {
  if (!topShaResolved || !topSha) return "low";
  const topAgreements = uniqueShas.filter((s) => s === topSha).length;
  if (topAgreements >= 2) return "high";
  return "medium";
}

export function createEnrichStackTraceTool(workspace: string) {
  return {
    schema: {
      name: "enrichStackTrace",
      description:
        "Map stack-trace frames to introducing commits via git blame. Parses Node/Python/browser traces, filters to in-workspace files, returns per-frame commit + overall top suspect.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["stackTrace"],
        properties: {
          stackTrace: {
            type: "string",
            description: "Full stack trace text. Multi-line; any language.",
            maxLength: 64_000,
          },
          maxFrames: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "Max frames to blame. Default 10. Top-of-stack first.",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          frames: {
            type: "array",
            items: {
              type: "object",
              properties: {
                file: { type: "string" },
                line: { type: "integer" },
                column: { type: ["integer", "null"] },
                function: { type: ["string", "null"] },
                language: { type: "string" },
                inWorkspace: { type: "boolean" },
                resolvedPath: { type: ["string", "null"] },
                commit: {
                  type: ["object", "null"],
                  properties: {
                    sha: { type: "string" },
                    author: { type: "string" },
                    date: { type: "string" },
                    subject: { type: "string" },
                  },
                },
              },
              required: ["file", "line", "language", "inWorkspace"],
            },
          },
          topSuspect: {
            type: ["object", "null"],
            properties: {
              sha: { type: "string" },
              author: { type: "string" },
              date: { type: "string" },
              subject: { type: "string" },
              frameCount: { type: "integer" },
            },
          },
          confidence: {
            type: "string",
            enum: ["high", "medium", "low"],
          },
          framesParsed: { type: "integer" },
          framesBlamed: { type: "integer" },
          gitAvailable: { type: "boolean" },
        },
        required: [
          "frames",
          "confidence",
          "framesParsed",
          "framesBlamed",
          "gitAvailable",
        ],
      },
    },
    timeoutMs: 30_000,
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const stackTrace = requireString(args, "stackTrace", 64_000);
      const maxFrames = optionalInt(args, "maxFrames", 1, 50) ?? 10;

      // Verify git repo up front so we return a meaningful `gitAvailable`.
      const check = await execSafe("git", ["rev-parse", "--git-dir"], {
        cwd: workspace,
        signal,
        timeout: 5_000,
      });
      const gitAvailable = check.exitCode === 0;

      const parsed = parseStackTrace(stackTrace);
      const framesParsed = parsed.length;
      const toConsider = parsed.slice(0, maxFrames);

      const resolver = createBlameResolver(workspace);
      const blameShaByIndex: Array<string | undefined> = new Array(
        toConsider.length,
      );

      if (gitAvailable) {
        // Blame sequentially — top-of-stack first. The cache inside
        // createBlameResolver makes repeat frames on the same file+line
        // free, so this is already cheap for the typical case.
        for (let i = 0; i < toConsider.length; i += 1) {
          const frame = toConsider[i] as StackFrame;
          const resolved = resolveFrameFile(workspace, frame.file);
          if (!resolved) continue;
          const sha = await resolver.getIntroducedByCommit(
            resolved,
            frame.line,
          );
          if (sha) blameShaByIndex[i] = sha;
        }
      }

      const uniqueShas = Array.from(
        new Set(
          blameShaByIndex.filter((s): s is string => typeof s === "string"),
        ),
      );
      const commitMetaCache = new Map<string, CommitMeta | null>();
      for (const sha of uniqueShas) {
        commitMetaCache.set(sha, await fetchCommitMeta(workspace, sha, signal));
      }

      const frames = toConsider.map((frame, i) => {
        const resolved = resolveFrameFile(workspace, frame.file);
        const sha = blameShaByIndex[i];
        const commit = sha ? (commitMetaCache.get(sha) ?? null) : null;
        return {
          file: frame.file,
          line: frame.line,
          column: frame.column,
          function: frame.function,
          language: frame.language,
          inWorkspace: resolved !== null,
          resolvedPath: resolved,
          commit,
        };
      });

      const allBlamedShas = blameShaByIndex.filter(
        (s): s is string => typeof s === "string",
      );
      const framesBlamed = allBlamedShas.length;
      const topSha = blameShaByIndex[0] ?? null;
      const confidence = scoreConfidence(
        Boolean(topSha),
        allBlamedShas,
        topSha,
      );

      let topSuspect: (CommitMeta & { frameCount: number }) | null = null;
      if (topSha) {
        const meta = commitMetaCache.get(topSha);
        if (meta) {
          topSuspect = {
            ...meta,
            frameCount: allBlamedShas.filter((s) => s === topSha).length,
          };
        }
      }

      return successStructured({
        frames,
        topSuspect,
        confidence,
        framesParsed,
        framesBlamed,
        gitAvailable,
      });
    },
  };
}
