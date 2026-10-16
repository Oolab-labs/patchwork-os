/**
 * `recipe doctor` / preflight must report an unacknowledged write with the
 * severity the RUNTIME will apply (audit M6). It used to be an error always,
 * for a rule the runtime only enforced behind a default-off flag — a red mark
 * that changes nothing is how operators learn to ignore red marks.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPreflight } from "../recipe.js";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pw-preflight-ack-"));
  file = path.join(dir, "writes.yaml");
  writeFileSync(
    file,
    `name: writes\ndescription: d\ntrigger:\n  type: manual\nsteps:\n  - tool: file.write\n    path: ${path.join(dir, "out.md")}\n    content: hi\n`,
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function ackIssue(r: Awaited<ReturnType<typeof runPreflight>>) {
  return r.issues.find((i) => i.code === "unacknowledged-write");
}

describe("preflight unacknowledged-write severity follows enforcement", () => {
  it("is an ERROR, and says the step will be refused, where it is enforced", async () => {
    const r = await runPreflight(file, { writeAckEnforced: true });
    expect(ackIssue(r)?.level).toBe("error");
    expect(ackIssue(r)?.message).toContain("will be refused");
  });

  it("is a WARNING, and says it will run, where it is not enforced", async () => {
    const r = await runPreflight(file, { writeAckEnforced: false });
    expect(ackIssue(r)?.level).toBe("warning");
    expect(ackIssue(r)?.message).toContain("not enforced");
  });
});
