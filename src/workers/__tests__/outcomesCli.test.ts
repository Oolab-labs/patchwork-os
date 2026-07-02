import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OutcomeStore } from "../outcomeStore.js";
import { formatOutcomeList, runOutcomesCli } from "../outcomesCli.js";

const URL = "https://github.com/o/r/issues/1";
const NOW = 1_700_000_000_000;

describe("runOutcomesCli", () => {
  let dir: string;
  let store: OutcomeStore;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "outcomes-cli-"));
    store = new OutcomeStore(dir);
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* OS reaps temp dir */
    }
  });

  it("confirm writes a `confirmed` disposition the trust replay can read", () => {
    const res = runOutcomesCli(["confirm", URL], { store, now: NOW });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Recorded confirmed");
    // round-trips through a FRESH store (proves it hit disk, not just cache)
    expect(new OutcomeStore(dir).getDisposition(URL)).toBe("confirmed");
  });

  it("reject writes a `junk` disposition", () => {
    const res = runOutcomesCli(["reject", URL], { store, now: NOW });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Recorded junk");
    expect(new OutcomeStore(dir).getDisposition(URL)).toBe("junk");
  });

  it("stamps --recipe and --class audit context onto the record", () => {
    runOutcomesCli(
      [
        "confirm",
        URL,
        "--recipe",
        "triage-failing-tests-autofile",
        "--class",
        "issue:compensable:high",
      ],
      { store, now: NOW },
    );
    const rec = new OutcomeStore(dir).readAll().find((r) => r.issueUrl === URL);
    expect(rec).toMatchObject({
      issueUrl: URL,
      disposition: "confirmed",
      checkedAt: NOW,
      recipeName: "triage-failing-tests-autofile",
      workerClass: "issue:compensable:high",
    });
  });

  it("confirm without a url is a usage error (exit 1, nothing written)", () => {
    const res = runOutcomesCli(["confirm"], { store, now: NOW });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("requires an <issue-url>");
    expect(new OutcomeStore(dir).readAll()).toEqual([]);
  });

  it("rejects a non-http(s) url (exit 1, nothing written)", () => {
    const res = runOutcomesCli(["confirm", "o/r#1"], { store, now: NOW });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("must be an http(s) URL");
    expect(new OutcomeStore(dir).readAll()).toEqual([]);
  });

  it("does not treat a flag-looking arg as the url", () => {
    const res = runOutcomesCli(["confirm", "--recipe"], { store, now: NOW });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("requires an <issue-url>");
  });

  it("list on an empty store prints a friendly empty message (exit 0)", () => {
    const res = runOutcomesCli(["list"], { store, now: NOW });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No recorded outcomes yet");
  });

  it("list renders recorded outcomes and --json emits a valid array", () => {
    runOutcomesCli(["confirm", URL], { store, now: NOW });
    runOutcomesCli(["reject", "https://github.com/o/r/issues/2"], {
      store,
      now: NOW,
    });

    const human = runOutcomesCli(["list"], { store, now: NOW });
    expect(human.stdout).toContain("2 recorded outcome(s):");
    expect(human.stdout).toContain(URL);

    const json = runOutcomesCli(["list", "--json"], { store, now: NOW });
    expect(json.exitCode).toBe(0);
    const parsed = JSON.parse(json.stdout ?? "[]");
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
  });

  it("last-writer-wins: reject then confirm ends confirmed", () => {
    runOutcomesCli(["reject", URL], { store, now: NOW });
    runOutcomesCli(["confirm", URL], { store, now: NOW + 1000 });
    expect(new OutcomeStore(dir).getDisposition(URL)).toBe("confirmed");
  });

  it("unknown subcommand is an error (exit 1)", () => {
    const res = runOutcomesCli(["frobnicate", URL], { store, now: NOW });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('unknown subcommand "frobnicate"');
  });

  it("bare `outcomes` prints usage as an error (exit 1); --help is exit 0", () => {
    expect(runOutcomesCli([], { store, now: NOW }).exitCode).toBe(1);
    expect(runOutcomesCli(["--help"], { store, now: NOW }).exitCode).toBe(0);
  });
});

describe("formatOutcomeList", () => {
  it("shows disposition, url, audit context and an ISO timestamp", () => {
    const out = formatOutcomeList([
      {
        issueUrl: URL,
        disposition: "confirmed",
        checkedAt: NOW,
        recipeName: "triage-failing-tests-autofile",
      },
    ]);
    expect(out).toContain("confirmed");
    expect(out).toContain(URL);
    expect(out).toContain("triage-failing-tests-autofile");
    expect(out).toContain(new Date(NOW).toISOString());
  });
});
