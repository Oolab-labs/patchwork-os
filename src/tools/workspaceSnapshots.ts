import {
  requireString,
  optionalString,
  optionalInt,
  optionalBool,
  execSafe,
  success,
  error,
  truncateOutput,
} from "./utils.js";

const SNAPSHOT_PREFIX = "claude-snapshot: ";
const MAX_SNAPSHOTS = 20;

interface ParsedSnapshot {
  index: number;
  name: string;
  timestamp: string;
  ref: string;
}

function parseStashList(stdout: string): ParsedSnapshot[] {
  const snapshots: ParsedSnapshot[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.includes(SNAPSHOT_PREFIX)) continue;
    const match = line.match(
      /^stash@\{(\d+)\}.*claude-snapshot:\s*(.+?)\s*\[(.+?)\]/,
    );
    if (match) {
      snapshots.push({
        index: parseInt(match[1]!, 10),
        name: match[2]!,
        timestamp: match[3]!,
        ref: `stash@{${match[1]}}`,
      });
    }
  }
  return snapshots;
}

function sanitizeName(name: string): string {
  const sanitized = name.replace(/[\n\r]/g, " ").replace(/[^\w\s\-_.]/g, "").trim();
  if (!sanitized) {
    throw new Error("Snapshot name must contain at least one word character after sanitization");
  }
  return sanitized;
}

async function verifySnapshotIndex(
  index: number,
  name: string,
  workspace: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const verifyResult = await execSafe("git", ["stash", "list"], { cwd: workspace, signal });
  const current = parseStashList(verifyResult.stdout);
  const atIndex = current.find((s) => s.index === index);
  if (!atIndex || atIndex.name !== name) {
    return "Stash index shifted — snapshot no longer at expected position. Re-run listSnapshots.";
  }
  return null;
}

export function createCreateSnapshotTool(workspace: string) {
  return {
    schema: {
      name: "createSnapshot",
      description:
        "Create a workspace snapshot using git stash. Saves all current changes (including untracked files) as a named checkpoint that can be restored later.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["name"],
        properties: {
          name: {
            type: "string",
            description: "Human-readable name for this snapshot",
          },
          includeUntracked: {
            type: "boolean",
            description: "Include untracked files in snapshot. Default: true",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ) => {
      const name = sanitizeName(requireString(args, "name", 200));
      const includeUntracked = optionalBool(args, "includeUntracked") ?? true;

      // Check git repo
      const gitCheck = await execSafe("git", ["rev-parse", "--git-dir"], {
        cwd: workspace,
        signal,
      });
      if (gitCheck.exitCode !== 0) {
        return error("Not a git repository");
      }

      // Cap snapshot count to prevent disk exhaustion
      const listResult = await execSafe("git", ["stash", "list"], {
        cwd: workspace,
        signal,
      });
      const existing = parseStashList(listResult.stdout);
      if (existing.length >= MAX_SNAPSHOTS) {
        return error(
          `Maximum of ${MAX_SNAPSHOTS} snapshots reached. Delete old snapshots before creating new ones.`,
        );
      }

      const timestamp = new Date().toISOString();
      const message = `${SNAPSHOT_PREFIX}${name} [${timestamp}]`;
      const stashArgs = ["stash", "push", "-m", message];
      if (includeUntracked) stashArgs.splice(2, 0, "-u");

      const result = await execSafe("git", stashArgs, {
        cwd: workspace,
        signal,
      });

      if (
        result.exitCode === 0 &&
        result.stdout.includes("No local changes")
      ) {
        return success({
          created: false,
          message: "No changes to snapshot",
        });
      }

      if (result.exitCode !== 0) {
        return error(result.stderr.trim() || "Failed to create snapshot");
      }

      // Re-apply the stash so the working tree is unchanged (non-destructive checkpoint)
      const applyResult = await execSafe(
        "git",
        ["stash", "apply", "stash@{0}"],
        { cwd: workspace, signal },
      );
      const restored = applyResult.exitCode === 0;

      return success({
        created: true,
        name,
        timestamp,
        message: result.stdout.trim(),
        ...(restored
          ? { workingTreeRestored: true }
          : { workingTreeRestored: false, restoreWarning: "Changes were stashed but could not be auto-restored. Use restoreSnapshot to get them back." }),
      });
    },
  };
}

export function createListSnapshotsTool(workspace: string) {
  return {
    schema: {
      name: "listSnapshots",
      description:
        "List all workspace snapshots (claude-snapshot entries in git stash).",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {},
        additionalProperties: false as const,
      },
    },
    handler: async (
      _args: Record<string, unknown>,
      signal?: AbortSignal,
    ) => {
      const gitCheck = await execSafe("git", ["rev-parse", "--git-dir"], {
        cwd: workspace,
        signal,
      });
      if (gitCheck.exitCode !== 0) {
        return error("Not a git repository");
      }

      const result = await execSafe("git", ["stash", "list"], {
        cwd: workspace,
        signal,
      });

      const snapshots = parseStashList(result.stdout);
      return success({ snapshots, count: snapshots.length });
    },
  };
}

export function createRestoreSnapshotTool(workspace: string) {
  return {
    schema: {
      name: "restoreSnapshot",
      description:
        "Restore a workspace snapshot by name or stash index. Uses 'git stash apply' (not pop) for safety — the snapshot remains available after restoring.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string",
            description:
              "Snapshot name to restore (matches against snapshot names)",
          },
          index: {
            type: "integer",
            description:
              "Stash index to restore (e.g., 0 for most recent). Use listSnapshots to find indices.",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ) => {
      const name = optionalString(args, "name");
      let index = optionalInt(args, "index", 0, 1000);

      if (name === undefined && index === undefined) {
        return error("Provide either 'name' or 'index'");
      }

      const gitCheck = await execSafe("git", ["rev-parse", "--git-dir"], {
        cwd: workspace,
        signal,
      });
      if (gitCheck.exitCode !== 0) {
        return error("Not a git repository");
      }

      // Look up by name if no index given
      if (index === undefined && name !== undefined) {
        const listResult = await execSafe("git", ["stash", "list"], {
          cwd: workspace,
          signal,
        });
        const snapshots = parseStashList(listResult.stdout);
        const found = snapshots.find((s) => s.name === name);
        if (!found) {
          return error(`No snapshot found with name: "${name}"`);
        }
        index = found.index;
      }

      // Verify stash at resolved index still matches (TOCTOU protection)
      if (name !== undefined) {
        const shiftErr = await verifySnapshotIndex(index!, name, workspace, signal);
        if (shiftErr) return error(shiftErr);
      }

      const result = await execSafe(
        "git",
        ["stash", "apply", `stash@{${index}}`],
        { cwd: workspace, signal },
      );

      if (result.exitCode !== 0) {
        const hasConflicts =
          result.stderr.toLowerCase().includes("conflict") ||
          result.stdout.toLowerCase().includes("conflict");
        if (hasConflicts) {
          return success({
            restored: true,
            conflicts: true,
            index,
            message:
              "Snapshot applied with conflicts. Resolve conflicts manually.",
          });
        }
        return error(result.stderr.trim() || "Failed to restore snapshot");
      }

      return success({
        restored: true,
        conflicts: false,
        index,
        message: "Snapshot applied successfully",
      });
    },
  };
}

export function createDeleteSnapshotTool(workspace: string) {
  return {
    schema: {
      name: "deleteSnapshot",
      description:
        "Permanently delete a workspace snapshot by name or stash index.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string",
            description: "Snapshot name to delete",
          },
          index: {
            type: "integer",
            description: "Stash index to delete",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ) => {
      const name = optionalString(args, "name");
      let index = optionalInt(args, "index", 0, 1000);

      if (name === undefined && index === undefined) {
        return error("Provide either 'name' or 'index'");
      }

      const gitCheck = await execSafe("git", ["rev-parse", "--git-dir"], {
        cwd: workspace,
        signal,
      });
      if (gitCheck.exitCode !== 0) {
        return error("Not a git repository");
      }

      if (index === undefined && name !== undefined) {
        const listResult = await execSafe("git", ["stash", "list"], {
          cwd: workspace,
          signal,
        });
        const snapshots = parseStashList(listResult.stdout);
        const found = snapshots.find((s) => s.name === name);
        if (!found) {
          return error(`No snapshot found with name: "${name}"`);
        }
        index = found.index;
      }

      // Verify stash at resolved index still matches (TOCTOU protection)
      if (name !== undefined) {
        const shiftErr = await verifySnapshotIndex(index!, name, workspace, signal);
        if (shiftErr) return error(shiftErr);
      }

      const result = await execSafe(
        "git",
        ["stash", "drop", `stash@{${index}}`],
        { cwd: workspace, signal },
      );

      if (result.exitCode !== 0) {
        return error(result.stderr.trim() || "Failed to delete snapshot");
      }

      return success({
        deleted: true,
        index,
        message: result.stdout.trim(),
      });
    },
  };
}

export function createDiffSnapshotTool(workspace: string) {
  return {
    schema: {
      name: "diffSnapshot",
      description:
        "Show what has changed in the working tree since a snapshot was taken. " +
        "Unlike showSnapshot (which shows what the snapshot contains), diffSnapshot shows " +
        "what is DIFFERENT between the snapshot state and the current working tree — " +
        "i.e., everything Claude or the user has done since the checkpoint. " +
        "Use this to audit changes before committing.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string",
            description: "Snapshot name to diff against",
          },
          index: {
            type: "integer",
            description: "Stash index to diff against. Use listSnapshots to find indices.",
          },
          stat: {
            type: "boolean",
            description: "If true, show only a file summary (--stat) instead of the full diff. Default: false",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const name = optionalString(args, "name");
      let index = optionalInt(args, "index", 0, 1000);
      const stat = optionalBool(args, "stat") ?? false;

      if (name === undefined && index === undefined) {
        return error("Provide either 'name' or 'index'");
      }

      const gitCheck = await execSafe("git", ["rev-parse", "--git-dir"], {
        cwd: workspace,
        signal,
      });
      if (gitCheck.exitCode !== 0) {
        return error("Not a git repository");
      }

      if (index === undefined && name !== undefined) {
        const listResult = await execSafe("git", ["stash", "list"], {
          cwd: workspace,
          signal,
        });
        const snapshots = parseStashList(listResult.stdout);
        const found = snapshots.find((s) => s.name === name);
        if (!found) {
          return error(`No snapshot found with name: "${name}"`);
        }
        index = found.index;
      }

      // Verify stash at resolved index still matches (TOCTOU protection)
      if (name !== undefined) {
        const shiftErr = await verifySnapshotIndex(index!, name, workspace, signal);
        if (shiftErr) return error(shiftErr);
      }

      // git diff stash@{N} compares the stash tree vs current working tree:
      //   - lines = was in snapshot, no longer in working tree (removed/reverted since snapshot)
      //   + lines = in working tree now but not in snapshot (added/changed since snapshot)
      const diffArgs = stat
        ? ["diff", "--stat", `stash@{${index}}`]
        : ["diff", `stash@{${index}}`];

      const result = await execSafe("git", diffArgs, {
        cwd: workspace,
        signal,
      });

      if (result.exitCode !== 0) {
        return error(result.stderr.trim() || "Failed to diff snapshot");
      }

      if (!result.stdout.trim()) {
        return success({
          index,
          stat,
          output: "",
          note: "No changes since this snapshot — working tree matches the snapshot state exactly.",
        });
      }

      const truncated = truncateOutput(result.stdout, 512 * 1024);
      return success({
        index,
        stat,
        output: truncated.text,
        ...(truncated.truncated && { truncated: true }),
      });
    },
  };
}

export function createShowSnapshotTool(workspace: string) {
  return {
    schema: {
      name: "showSnapshot",
      description:
        "Inspect the contents of a workspace snapshot without restoring it. Shows the diff or file summary.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string",
            description: "Snapshot name to inspect",
          },
          index: {
            type: "integer",
            description: "Stash index to inspect",
          },
          stat: {
            type: "boolean",
            description:
              "If true, show file summary (--stat) instead of full diff. Default: false",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ) => {
      const name = optionalString(args, "name");
      let index = optionalInt(args, "index", 0, 1000);
      const stat = optionalBool(args, "stat") ?? false;

      if (name === undefined && index === undefined) {
        return error("Provide either 'name' or 'index'");
      }

      const gitCheck = await execSafe("git", ["rev-parse", "--git-dir"], {
        cwd: workspace,
        signal,
      });
      if (gitCheck.exitCode !== 0) {
        return error("Not a git repository");
      }

      if (index === undefined && name !== undefined) {
        const listResult = await execSafe("git", ["stash", "list"], {
          cwd: workspace,
          signal,
        });
        const snapshots = parseStashList(listResult.stdout);
        const found = snapshots.find((s) => s.name === name);
        if (!found) {
          return error(`No snapshot found with name: "${name}"`);
        }
        index = found.index;
      }

      // Verify stash at resolved index still matches (TOCTOU protection)
      if (name !== undefined) {
        const shiftErr = await verifySnapshotIndex(index!, name, workspace, signal);
        if (shiftErr) return error(shiftErr);
      }

      const showArgs = stat
        ? ["stash", "show", "--stat", `stash@{${index}}`]
        : ["stash", "show", "-p", `stash@{${index}}`];

      const result = await execSafe("git", showArgs, {
        cwd: workspace,
        signal,
      });

      if (result.exitCode !== 0) {
        return error(result.stderr.trim() || "Failed to show snapshot");
      }

      const truncated = truncateOutput(result.stdout, 512 * 1024);
      return success({
        index,
        stat,
        output: truncated.text,
        ...(truncated.truncated && { truncated: true }),
      });
    },
  };
}
