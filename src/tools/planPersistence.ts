import fsp from "node:fs/promises";
import path from "node:path";
import {
  error,
  optionalString,
  requireString,
  resolveFilePath,
  successStructured,
} from "./utils.js";

interface PlanFrontmatter {
  title: string;
  created: string;
  updated: string;
}

interface PlanTask {
  text: string;
  completed: boolean;
}

interface PlanSection {
  name: string;
  tasks: PlanTask[];
  body: string[];
}

interface ParsedPlan {
  frontmatter: PlanFrontmatter;
  sections: PlanSection[];
}

function parsePlanMarkdown(content: string): ParsedPlan {
  const lines = content.split("\n");
  let title = "";
  let created = "";
  let updated = "";

  let i = 0;
  // Parse frontmatter
  if (lines[0]?.trim() === "---") {
    i = 1;
    while (i < lines.length && lines[i]?.trim() !== "---") {
      const line = lines[i] ?? "";
      const match = line.match(/^(\w+):\s*(.+)/);
      if (match) {
        const [, key, val] = match;
        if (key === "title") title = (val ?? "").trim();
        else if (key === "created") created = (val ?? "").trim();
        else if (key === "updated") updated = (val ?? "").trim();
      }
      i++;
    }
    if (i < lines.length) i++; // skip closing ---
  }

  const sections: PlanSection[] = [];
  let currentSection: PlanSection | null = null;

  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const headingMatch = line.match(/^## (.+)/);
    if (headingMatch) {
      currentSection = { name: headingMatch[1] ?? "", tasks: [], body: [] };
      sections.push(currentSection);
      continue;
    }
    if (!currentSection) continue;

    const taskMatch = line.match(/^- \[([ xX])\] (.+)/);
    if (taskMatch) {
      currentSection.tasks.push({
        completed: taskMatch[1]?.toLowerCase() === "x",
        text: taskMatch[2] ?? "",
      });
    } else {
      currentSection.body.push(line);
    }
  }

  return {
    frontmatter: { title, created, updated },
    sections,
  };
}

function serializePlan(plan: ParsedPlan): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`title: ${plan.frontmatter.title}`);
  lines.push(`created: ${plan.frontmatter.created}`);
  lines.push(`updated: ${plan.frontmatter.updated}`);
  lines.push("---");
  lines.push("");

  for (const section of plan.sections) {
    lines.push(`## ${section.name}`);
    lines.push("");
    for (const task of section.tasks) {
      lines.push(`- [${task.completed ? "x" : " "}] ${task.text}`);
    }
    for (const bodyLine of section.body) {
      if (bodyLine.trim() !== "" || section.tasks.length === 0) {
        lines.push(bodyLine);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function createPlanTools(workspace: string) {
  const createPlan = {
    schema: {
      name: "createPlan",
      description:
        "Create a new plan file (.claude-plan.md) in the workspace root. Plans are markdown files with sections and task checklists that persist across sessions.",
      inputSchema: {
        type: "object" as const,
        required: ["title"],
        properties: {
          title: { type: "string", description: "Plan title" },
          fileName: {
            type: "string",
            description:
              "Custom filename (default: .claude-plan.md). Must end in .md",
          },
          sections: {
            type: "array",
            description: "Plan sections with tasks",
            items: {
              type: "object",
              required: ["name"],
              additionalProperties: false,
              properties: {
                name: { type: "string", description: "Section heading" },
                tasks: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Task descriptions (added as unchecked checkboxes)",
                },
              },
            },
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          created: { type: "boolean" },
          fileName: { type: "string" },
          path: { type: "string" },
          sections: { type: "integer" },
          tasks: { type: "integer" },
        },
        required: ["created", "fileName", "path"],
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const title = requireString(args, "title");
      const fileName = optionalString(args, "fileName") ?? ".claude-plan.md";
      if (!fileName.endsWith(".md")) {
        return error("fileName must end with .md");
      }
      const resolved = resolveFilePath(fileName, workspace, { write: true });

      if (
        await fsp.access(resolved).then(
          () => true,
          () => false,
        )
      ) {
        return error(
          `Plan file "${fileName}" already exists. Use updatePlan to modify it.`,
        );
      }

      const now = new Date().toISOString();
      const sections: PlanSection[] = [];
      const rawSections = args.sections;
      if (Array.isArray(rawSections)) {
        if (rawSections.length > 50) {
          return error("Maximum 50 sections allowed");
        }
        for (const s of rawSections) {
          const sec = s as { name?: string; tasks?: string[] };
          if (typeof sec.name !== "string") continue;
          const tasks: PlanTask[] = [];
          if (Array.isArray(sec.tasks)) {
            if (sec.tasks.length > 200) {
              return error(`Section "${sec.name}" exceeds 200 task limit`);
            }
            for (const t of sec.tasks) {
              if (typeof t === "string") {
                tasks.push({ text: t, completed: false });
              }
            }
          }
          sections.push({ name: sec.name, tasks, body: [] });
        }
      }

      const plan: ParsedPlan = {
        frontmatter: { title, created: now, updated: now },
        sections,
      };

      const content = serializePlan(plan);
      await fsp.writeFile(resolved, content, "utf-8");

      const totalTasks = sections.reduce((n, s) => n + s.tasks.length, 0);
      return successStructured({
        created: true,
        fileName,
        path: resolved,
        sections: sections.length,
        tasks: totalTasks,
      });
    },
  };

  const updatePlan = {
    schema: {
      name: "updatePlan",
      description:
        "Update an existing plan file. Can mark tasks complete/incomplete, add tasks to sections, or add new sections.",
      annotations: { idempotentHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          fileName: {
            type: "string",
            description: "Plan filename (default: .claude-plan.md)",
          },
          markComplete: {
            type: "array",
            description: "Task texts to mark as complete (substring match)",
            items: { type: "string" },
          },
          markIncomplete: {
            type: "array",
            description: "Task texts to mark as incomplete (substring match)",
            items: { type: "string" },
          },
          addTasks: {
            type: "array",
            description: "Tasks to add to a section",
            items: {
              type: "object",
              required: ["section", "tasks"],
              additionalProperties: false,
              properties: {
                section: {
                  type: "string",
                  description: "Section name to add tasks to",
                },
                tasks: { type: "array", items: { type: "string" } },
              },
            },
          },
          addSections: {
            type: "array",
            description: "New sections to append",
            items: {
              type: "object",
              required: ["name"],
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                tasks: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          updated: { type: "boolean" },
          changes: { type: "array", items: { type: "string" } },
        },
        required: ["updated", "changes"],
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const fileName = optionalString(args, "fileName") ?? ".claude-plan.md";
      const resolved = resolveFilePath(fileName, workspace, { write: true });

      if (
        !(await fsp.access(resolved).then(
          () => true,
          () => false,
        ))
      ) {
        return error(
          `Plan file "${fileName}" not found. Use createPlan to create one.`,
        );
      }

      const content = await fsp.readFile(resolved, "utf-8");
      const plan = parsePlanMarkdown(content);
      const changes: string[] = [];

      // Mark tasks complete
      const markComplete = args.markComplete;
      if (Array.isArray(markComplete)) {
        for (const substr of markComplete) {
          if (typeof substr !== "string") continue;
          for (const section of plan.sections) {
            for (const task of section.tasks) {
              if (!task.completed && task.text.includes(substr)) {
                task.completed = true;
                changes.push(`Completed: "${task.text}"`);
              }
            }
          }
        }
      }

      // Mark tasks incomplete
      const markIncomplete = args.markIncomplete;
      if (Array.isArray(markIncomplete)) {
        for (const substr of markIncomplete) {
          if (typeof substr !== "string") continue;
          for (const section of plan.sections) {
            for (const task of section.tasks) {
              if (task.completed && task.text.includes(substr)) {
                task.completed = false;
                changes.push(`Uncompleted: "${task.text}"`);
              }
            }
          }
        }
      }

      // Add tasks to existing sections
      const addTasks = args.addTasks;
      if (Array.isArray(addTasks) && addTasks.length > 50) {
        return error("Maximum 50 addTasks entries allowed");
      }
      if (Array.isArray(addTasks)) {
        for (const entry of addTasks) {
          const e = entry as { section?: string; tasks?: string[] };
          if (typeof e.section !== "string" || !Array.isArray(e.tasks))
            continue;
          const section = plan.sections.find((s) => s.name === e.section);
          if (!section) {
            changes.push(`Section "${e.section}" not found, skipped`);
            continue;
          }
          for (const t of e.tasks) {
            if (typeof t === "string") {
              section.tasks.push({ text: t, completed: false });
              changes.push(`Added task to "${e.section}": "${t}"`);
            }
          }
        }
      }

      // Add new sections
      const addSections = args.addSections;
      if (Array.isArray(addSections) && addSections.length > 50) {
        return error("Maximum 50 addSections entries allowed");
      }
      if (Array.isArray(addSections)) {
        for (const entry of addSections) {
          const e = entry as { name?: string; tasks?: string[] };
          if (typeof e.name !== "string") continue;
          const tasks: PlanTask[] = [];
          if (Array.isArray(e.tasks)) {
            for (const t of e.tasks) {
              if (typeof t === "string") {
                tasks.push({ text: t, completed: false });
              }
            }
          }
          plan.sections.push({ name: e.name, tasks, body: [] });
          changes.push(
            `Added section "${e.name}" with ${tasks.length} task(s)`,
          );
        }
      }

      plan.frontmatter.updated = new Date().toISOString();
      await fsp.writeFile(resolved, serializePlan(plan), "utf-8");

      return successStructured({ updated: true, changes });
    },
  };

  const getPlan = {
    schema: {
      name: "getPlan",
      description:
        "Read the current plan file and return its content as structured data with title, sections, tasks, and completion status.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          fileName: {
            type: "string",
            description: "Plan filename (default: .claude-plan.md)",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          found: { type: "boolean" },
          fileName: { type: "string" },
          title: { type: "string" },
          created: { type: "string" },
          updated: { type: "string" },
          sections: { type: "array" },
          summary: { type: "object" },
        },
        required: ["found"],
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const fileName = optionalString(args, "fileName") ?? ".claude-plan.md";
      const resolved = resolveFilePath(fileName, workspace);

      if (
        !(await fsp.access(resolved).then(
          () => true,
          () => false,
        ))
      ) {
        return successStructured({ found: false, fileName });
      }

      const content = await fsp.readFile(resolved, "utf-8");
      const plan = parsePlanMarkdown(content);

      let total = 0;
      let completed = 0;
      const sections = plan.sections.map((s) => {
        total += s.tasks.length;
        completed += s.tasks.filter((t) => t.completed).length;
        return {
          name: s.name,
          tasks: s.tasks.map((t) => ({
            text: t.text,
            completed: t.completed,
          })),
        };
      });

      return successStructured({
        found: true,
        title: plan.frontmatter.title,
        created: plan.frontmatter.created,
        updated: plan.frontmatter.updated,
        sections,
        summary: { total, completed, remaining: total - completed },
      });
    },
  };

  const deletePlan = {
    schema: {
      name: "deletePlan",
      description: "Delete a plan file from the workspace root.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["fileName"],
        properties: {
          fileName: {
            type: "string",
            description: "Plan filename to delete (e.g., '.claude-plan.md')",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          deleted: { type: "boolean" },
          fileName: { type: "string" },
        },
        required: ["deleted", "fileName"],
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const fileName = requireString(args, "fileName");
      if (!fileName.endsWith(".md")) {
        return error("fileName must end with .md");
      }
      const basename = path.basename(fileName);
      if (
        !basename.endsWith(".claude-plan.md") &&
        !basename.match(/^\.claude-plan.*\.md$/)
      ) {
        return error(
          "fileName must be a plan file (e.g., '.claude-plan.md' or 'project.claude-plan.md')",
        );
      }
      const resolved = resolveFilePath(fileName, workspace, { write: true });

      if (
        !(await fsp.access(resolved).then(
          () => true,
          () => false,
        ))
      ) {
        return error(`Plan file "${fileName}" not found.`);
      }

      await fsp.unlink(resolved);
      return successStructured({ deleted: true, fileName });
    },
  };

  const listPlans = {
    schema: {
      name: "listPlans",
      description:
        "List all plan files in the workspace root. Returns filenames with titles from frontmatter.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {},
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          plans: { type: "array" },
          count: { type: "integer" },
        },
        required: ["plans", "count"],
      },
    },
    handler: async () => {
      const entries = await fsp.readdir(workspace);
      const plans: Array<{
        fileName: string;
        title: string;
        created: string;
        updated: string;
      }> = [];

      for (const entry of entries) {
        if (
          entry.endsWith(".claude-plan.md") ||
          entry.match(/^\.claude-plan.*\.md$/)
        ) {
          try {
            const content = await fsp.readFile(
              path.join(workspace, entry),
              "utf-8",
            );
            const plan = parsePlanMarkdown(content);
            plans.push({
              fileName: entry,
              title: plan.frontmatter.title,
              created: plan.frontmatter.created,
              updated: plan.frontmatter.updated,
            });
          } catch {
            plans.push({
              fileName: entry,
              title: "",
              created: "",
              updated: "",
            });
          }
        }
      }

      return successStructured({ plans, count: plans.length });
    },
  };

  return [createPlan, updatePlan, getPlan, deletePlan, listPlans];
}
