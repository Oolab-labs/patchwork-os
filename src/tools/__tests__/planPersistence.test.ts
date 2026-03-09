import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPlanTools } from "../planPersistence.js";

function parse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content.at(0)?.text ?? "{}");
}

describe("planPersistence tools", () => {
  let tmpDir: string;
  let tools: ReturnType<typeof createPlanTools>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-"));
    tools = createPlanTools(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function getTool(name: string) {
    const tool = tools.find((t) => t.schema.name === name);
    if (!tool) throw new Error(`Tool "${name}" not found`);
    return tool;
  }

  it("createPlan creates a plan file and readback with getPlan works", async () => {
    const createPlan = getTool("createPlan");
    const createResult = await createPlan.handler({
      title: "Test Plan",
      sections: [{ name: "Tasks", tasks: ["Do thing A", "Do thing B"] }],
    });
    const createData = parse(createResult);
    expect(createData.created).toBe(true);
    expect(createData.fileName).toBe(".claude-plan.md");

    const getPlan = getTool("getPlan");
    const getResult = await getPlan.handler({});
    const getData = parse(getResult);

    expect(getData.found).toBe(true);
    expect(getData.title).toBe("Test Plan");
    expect(getData.sections).toHaveLength(1);
    expect(getData.sections[0].name).toBe("Tasks");
    expect(getData.sections[0].tasks).toHaveLength(2);
    expect(getData.sections[0].tasks[0].text).toBe("Do thing A");
    expect(getData.sections[0].tasks[0].completed).toBe(false);
  });

  it("listPlans returns the created plan", async () => {
    const createPlan = getTool("createPlan");
    await createPlan.handler({ title: "Listed Plan" });

    const listPlans = getTool("listPlans");
    const result = await listPlans.handler();
    const data = parse(result);

    expect(data.count).toBeGreaterThanOrEqual(1);
    const found = data.plans.find((p: { fileName: string }) => p.fileName === ".claude-plan.md");
    expect(found).toBeDefined();
    expect(found.title).toBe("Listed Plan");
  });

  it("updatePlan markComplete flips a task from unchecked to checked", async () => {
    const createPlan = getTool("createPlan");
    await createPlan.handler({
      title: "Mark Complete Plan",
      sections: [{ name: "Work", tasks: ["First task", "Second task"] }],
    });

    const updatePlan = getTool("updatePlan");
    const updateResult = await updatePlan.handler({ markComplete: ["First task"] });
    const updateData = parse(updateResult);
    expect(updateData.updated).toBe(true);

    const getPlan = getTool("getPlan");
    const getResult = await getPlan.handler({});
    const getData = parse(getResult);

    const firstTask = getData.sections[0].tasks.find((t: { text: string }) => t.text === "First task");
    expect(firstTask.completed).toBe(true);

    const secondTask = getData.sections[0].tasks.find((t: { text: string }) => t.text === "Second task");
    expect(secondTask.completed).toBe(false);
  });

  it("deletePlan removes the file and it no longer appears in listPlans", async () => {
    const createPlan = getTool("createPlan");
    // Use a custom filename because deletePlan requires it to end in .claude-plan.md
    await createPlan.handler({ title: "To Delete", fileName: "project.claude-plan.md" });

    const deletePlan = getTool("deletePlan");
    const deleteResult = await deletePlan.handler({ fileName: "project.claude-plan.md" });
    const deleteData = parse(deleteResult);
    expect(deleteData.deleted).toBe(true);

    expect(fs.existsSync(path.join(tmpDir, "project.claude-plan.md"))).toBe(false);

    const listPlans = getTool("listPlans");
    const listResult = await listPlans.handler();
    const listData = parse(listResult);
    const found = listData.plans.find((p: { fileName: string }) => p.fileName === "project.claude-plan.md");
    expect(found).toBeUndefined();
  });
});
