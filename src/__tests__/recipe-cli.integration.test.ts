import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = path.resolve(
  import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const srcIndex = path.join(workspaceRoot, "src", "index.ts");
const tsxBin = path.join(workspaceRoot, "node_modules", ".bin", "tsx");

const tmpDirs: string[] = [];
const childProcs = new Set<ChildProcess>();

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "patchwork-recipe-cli-"));
  tmpDirs.push(dir);
  return dir;
}

function collectStream(
  stream: NodeJS.ReadableStream | null | undefined,
  lines: string[],
): void {
  stream?.on("data", (chunk: Buffer | string) => {
    chunk
      .toString()
      .split("\n")
      .filter(Boolean)
      .forEach((line) => {
        lines.push(line);
      });
  });
}

function waitForLine(
  lines: string[],
  pattern: RegExp,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (lines.some((line) => pattern.test(line))) {
        resolve();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(
          new Error(
            `Timed out waiting for ${pattern} in output: ${lines.join("\n")}`,
          ),
        );
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

function waitForExit(
  proc: ChildProcess,
  timeoutMs: number,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for process exit")),
      timeoutMs,
    );
    proc.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

afterEach(async () => {
  for (const proc of childProcs) {
    if (proc.exitCode === null && !proc.killed) {
      proc.kill("SIGKILL");
      try {
        await waitForExit(proc, 2_000);
      } catch {
        // best effort
      }
    }
  }
  childProcs.clear();

  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

describe("recipe CLI integration", () => {
  it("recipe run prints the shared local execution summary for an explicit file", () => {
    const homeDir = makeTmpDir();
    const recipeDir = makeTmpDir();
    const recipePath = path.join(recipeDir, "run-cli.yaml");
    const outputPath = path.join(recipeDir, "run-cli-output.txt");

    fs.writeFileSync(
      recipePath,
      `name: run-cli\ndescription: Run CLI\ntrigger:\n  type: manual\nsteps:\n  - tool: file.write\n    path: ${JSON.stringify(outputPath)}\n    content: "run cli"\n`,
    );

    const result = spawnSync(tsxBin, [srcIndex, "recipe", "run", recipePath], {
      cwd: workspaceRoot,
      encoding: "utf-8",
      env: { ...process.env, HOME: homeDir },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Running recipe "${recipePath}" locally`);
    expect(result.stdout).toContain("✓ 1 step(s) completed");
    expect(result.stdout).toContain("Output written to:");
    expect(result.stdout).toContain(outputPath);
    expect(fs.readFileSync(outputPath, "utf-8")).toBe("run cli");
  });

  it("recipe watch reruns the recipe on save and prints run output", async () => {
    const homeDir = makeTmpDir();
    const recipeDir = makeTmpDir();
    const recipePath = path.join(recipeDir, "watch-cli.yaml");
    const outputPath = path.join(recipeDir, "watch-cli-output.txt");

    fs.writeFileSync(
      recipePath,
      `name: watch-cli\ndescription: Watch CLI\ntrigger:\n  type: manual\nsteps:\n  - tool: file.write\n    path: ${JSON.stringify(outputPath)}\n    content: "first"\n`,
    );

    const proc = spawn(tsxBin, [srcIndex, "recipe", "watch", recipePath], {
      cwd: workspaceRoot,
      env: { ...process.env, HOME: homeDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    childProcs.add(proc);

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    collectStream(proc.stdout, stdoutLines);
    collectStream(proc.stderr, stderrLines);

    await waitForLine(stdoutLines, /Watching .* for changes/, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 100));

    fs.writeFileSync(
      recipePath,
      `name: watch-cli\ndescription: Watch CLI\ntrigger:\n  type: manual\nsteps:\n  - tool: file.write\n    path: ${JSON.stringify(outputPath)}\n    content: "second"\n`,
    );

    await waitForLine(stdoutLines, /Change detected, running/, 10_000);
    await waitForLine(stdoutLines, /✓ 1 step\(s\) completed/, 10_000);
    await waitForLine(
      stdoutLines,
      new RegExp(outputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      10_000,
    );

    expect(fs.readFileSync(outputPath, "utf-8")).toBe("second");
    expect(stderrLines.join("\n")).not.toContain("Invalid (");

    proc.kill("SIGINT");
    const exitCode = await waitForExit(proc, 10_000);
    childProcs.delete(proc);

    expect(exitCode).toBe(0);
    expect(stdoutLines.join("\n")).toContain("Stopping watch");
  }, 20_000);
});
