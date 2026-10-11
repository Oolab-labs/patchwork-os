import { describe, expect, it } from "vitest";
import { agentTextFromTask } from "../recipeOrchestration.js";
import { detectSilentFail } from "../recipes/stepObservation.js";

/**
 * A failed orchestrator task must not read as the agent's answer.
 *
 * Both orchestrator-backed agent paths did `task.output ?? task.errorMessage ??
 * ""`. When the task failed, `output` was undefined and the driver's thrown
 * message came back as the agent step's SUCCESSFUL result, unmarked. The runner
 * cannot tell that from a real answer, so it flowed into the step's `into`
 * variable and onward.
 *
 * Observed live on 2026-08-13: an orchestrator task failed with "OpenAIApiDriver
 * requires openai — install it with: npm install openai", that string became the
 * proposed task title, the recipe's `{{title}} != DUPLICATE` guard passed (an
 * error string is not "DUPLICATE"), and a worker asked a human to approve
 * creating a Todoist task with that title. The gate asking is the only reason it
 * did not land — approve on autopilot and it writes nonsense to a real external
 * service.
 *
 * `makeProviderDriverFn` already marked its failures this way. Only this path
 * did not, and the two sites here were byte-identical duplicates that still
 * drifted from that third one — hence one exported helper rather than two
 * corrected copies.
 */
describe("agentTextFromTask", () => {
  it("marks a failed task so the runner can see it failed", () => {
    const text = agentTextFromTask({
      errorMessage:
        "OpenAIApiDriver requires openai — install it with: npm install openai",
    });
    expect(text).toContain("[agent step failed:");
    expect(text).toContain("OpenAIApiDriver requires openai");
  });

  it("the marked text is recognised as a silent failure", () => {
    // The point of marking: detectSilentFail must catch it. Without this the
    // string is indistinguishable from a legitimate answer.
    const text = agentTextFromTask({ errorMessage: "boom" });
    expect(detectSilentFail(text)).not.toBeNull();
  });

  it("a raw driver error would NOT be caught — why marking happens at the source", () => {
    // Anchor for the design decision. This is the string the old code returned.
    // It is not recognisable downstream, and no reasonable pattern list would
    // catch every shape a driver error can take.
    expect(
      detectSilentFail(
        "OpenAIApiDriver requires openai — install it with: npm install openai",
      ),
    ).toBeNull();
  });

  it("passes a successful task's output through unchanged", () => {
    // Anchor against over-marking: a real answer must survive intact, including
    // one that merely mentions failure.
    expect(agentTextFromTask({ output: "Descale the coffee machine" })).toBe(
      "Descale the coffee machine",
    );
    expect(
      agentTextFromTask({ output: "The build failed; investigate the linker" }),
    ).toBe("The build failed; investigate the linker");
  });

  it("a FAILED task is marked even when it carries output", () => {
    // On failure the orchestrator stores the driver's text in `output` AND sets
    // `errorMessage` + status "error". Preferring `output` turned a CLI's own
    // error text into the step's answer: with no Claude sign-in, a recipe
    // wrote "Not logged in · Please run /login" to the inbox and the run
    // finished `done`. The task's status is the authoritative signal.
    const text = agentTextFromTask({
      status: "error",
      output: "Not logged in · Please run /login",
      errorMessage: "Process exited with code 1",
    });
    expect(text.startsWith("[agent step failed:")).toBe(true);
    expect(text).toContain("Process exited with code 1");
    expect(text).toContain("Not logged in");
    expect(detectSilentFail(text)).not.toBeNull();
  });

  it("a cancelled or timed-out task's partial output is not an answer", () => {
    const text = agentTextFromTask({
      status: "cancelled",
      output: "partial thought, cut off mid-",
    });
    expect(text.startsWith("[agent step failed:")).toBe(true);
    expect(detectSilentFail(text)).not.toBeNull();
  });

  it("a done task's output passes through even if an errorMessage lingers", () => {
    expect(
      agentTextFromTask({
        status: "done",
        output: "real answer",
        errorMessage: "ignored",
      }),
    ).toBe("real answer");
  });

  it("returns empty string when a task carries neither", () => {
    expect(agentTextFromTask({})).toBe("");
  });

  it("caps a long error so one failure cannot flood a prompt or a record", () => {
    const text = agentTextFromTask({ errorMessage: "x".repeat(5000) });
    expect(text.length).toBeLessThan(300);
  });
});
