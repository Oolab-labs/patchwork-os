import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BRIDGE_BIN =
  process.platform === "win32" ? "claude-ide-bridge.cmd" : "claude-ide-bridge";

// Mock vscode
vi.mock("vscode", () => ({
  window: {
    withProgress: vi.fn(async (_opts: unknown, task: () => Promise<void>) =>
      task(),
    ),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    setStatusBarMessage: vi.fn(),
  },
  ProgressLocation: { Window: 10 },
}));

// Mock child_process.execFile (used via promisify)
vi.mock("node:child_process", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:child_process")>();
  return {
    ...mod,
    execFile: vi.fn(),
  };
});

// Inject BRIDGE_VERSION global before importing BridgeInstaller
(globalThis as Record<string, unknown>).BRIDGE_VERSION = "2.0.1";

import { execFile } from "node:child_process";
import * as vscode from "vscode";
import { BridgeInstaller } from "../bridgeInstaller";

const mockedExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

// Helper: make execFile call its callback with stdout
function mockExec(stdout: string, stderr = "", code = 0) {
  mockedExecFile.mockImplementationOnce(
    (_bin: string, _args: string[], _opts: unknown, cb: Function) => {
      if (code === 0) cb(null, { stdout, stderr });
      else cb(new Error(stderr || "exec failed"), { stdout: "", stderr });
    },
  );
}

let output: { appendLine: ReturnType<typeof vi.fn> };
let installer: BridgeInstaller;

beforeEach(() => {
  mockedExecFile.mockReset();
  output = { appendLine: vi.fn() };
  installer = new BridgeInstaller(
    output as unknown as import("vscode").OutputChannel,
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("BridgeInstaller.getInstalledVersion", () => {
  it("returns semver from claude-ide-bridge --version output", async () => {
    mockExec("claude-ide-bridge 2.0.0\n");
    const v = await installer.getInstalledVersion();
    expect(v).toBe("2.0.0");
  });

  it("returns null when binary not found", async () => {
    mockedExecFile.mockImplementationOnce(
      (_bin: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error("ENOENT"));
      },
    );
    const v = await installer.getInstalledVersion();
    expect(v).toBeNull();
  });
});

describe("BridgeInstaller.getRequiredVersion", () => {
  it("returns the injected BRIDGE_VERSION", () => {
    expect(installer.getRequiredVersion()).toBe("2.0.1");
  });
});

describe("BridgeInstaller.ensureInstalled", () => {
  it("is a no-op when installed version matches required", async () => {
    // getInstalledVersion returns 2.0.1 (matches BRIDGE_VERSION)
    mockExec("2.0.1\n");
    await installer.ensureInstalled();
    // npm install should NOT have been called
    expect(mockedExecFile).toHaveBeenCalledTimes(1);
    expect(mockedExecFile.mock.calls[0][0]).toBe(BRIDGE_BIN);
  });

  it("calls npm install when bridge is not installed", async () => {
    // getInstalledVersion → null (not found)
    mockedExecFile.mockImplementationOnce(
      (_bin: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error("ENOENT"));
      },
    );
    // npm install succeeds
    mockExec("", "", 0);

    await installer.ensureInstalled();

    expect(mockedExecFile).toHaveBeenCalledTimes(2);
    const npmCall = mockedExecFile.mock.calls[1];
    expect(npmCall[0]).toMatch(/npm/);
    expect(npmCall[1]).toContain("install");
    expect(npmCall[1]).toContain("-g");
    expect(npmCall[1].some((a: string) => a.includes("2.0.1"))).toBe(true);
  });

  it("calls npm install when installed version is outdated", async () => {
    mockExec("1.9.0\n"); // outdated
    mockExec("", "", 0); // npm install succeeds

    await installer.ensureInstalled();

    expect(mockedExecFile).toHaveBeenCalledTimes(2);
  });

  it("shows warning when npm is not found", async () => {
    // getInstalledVersion → null
    mockedExecFile.mockImplementationOnce(
      (_bin: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error("ENOENT"));
      },
    );
    // npm install → ENOENT
    mockedExecFile.mockImplementationOnce(
      (_bin: string, _args: string[], _opts: unknown, cb: Function) => {
        const err = new Error("ENOENT: npm not found");
        cb(err, { stdout: "", stderr: "" });
      },
    );

    await expect(installer.ensureInstalled()).rejects.toThrow();
    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The installer must never leave a machine with an older bridge than it found.
//
// These tests do not assert on call shapes alone. They run the installer
// against a stand-in for the machine, which knows the TRUE installed version
// even when the installer's own version check cannot read it, and then look at
// what is installed afterwards.
// ─────────────────────────────────────────────────────────────────────────────

const NPM_BIN = process.platform === "win32" ? "npm.cmd" : "npm";

/** How `claude-ide-bridge --version` behaves when a binary IS on PATH. */
type CheckBehaviour =
  | "ok"
  | "timeout"
  | "exit-1"
  | "no-version"
  | "eacces"
  | "einval";

interface Install {
  /** What followed `patchwork-os@` on the command line. */
  spec: string;
  /** The concrete version that spec meant at the time. */
  resolved: string;
  /** What was on the machine just before this install ran. */
  replaced: { onPath: string | null; inNpm: string | null };
}

interface Machine {
  /** Version of the `claude-ide-bridge` on PATH; null when there is none. */
  onPath: string | null;
  check: CheckBehaviour;
  /** Version in npm's global directory; null when npm holds no copy. */
  inNpm: string | null;
  /** Whether `npm ls -g` gives a readable answer. */
  list: "ok" | "garbage";
  /** What the registry's `latest` tag points at; null = registry unreachable. */
  latest: string | null;
  npmInstalled: boolean;
  /** The copy on PATH is npm's copy (the usual case). */
  npmBinOnPath: boolean;
  installFails: boolean;
  installs: Install[];
  commands: string[];
  unexpected: string[];
}

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    onPath: null,
    check: "ok",
    inNpm: null,
    list: "ok",
    latest: "2.4.0",
    npmInstalled: true,
    npmBinOnPath: true,
    installFails: false,
    installs: [],
    commands: [],
    unexpected: [],
    ...overrides,
  };
}

/** The usual machine: one global copy, and it is the one on PATH. */
function machineWith(
  version: string,
  overrides: Partial<Machine> = {},
): Machine {
  return machine({ onPath: version, inNpm: version, ...overrides });
}

type Output = { stdout: string; stderr: string };

type ExecCallback = (err: Error | null, value?: Output) => void;

// Error shapes copied from what Node reports, not invented: a failed spawn
// carries a string `code`, a non-zero exit a numeric one, a timeout `killed`.
function spawnError(code: string, bin: string): Error {
  return Object.assign(new Error(`spawn ${bin} ${code}`), {
    code,
    errno: -2,
    syscall: `spawn ${bin}`,
    path: bin,
  });
}

function exitError(
  bin: string,
  args: string[],
  exitCode: number,
  stdout = "",
  stderr = "",
): Error {
  return Object.assign(
    new Error(`Command failed: ${bin} ${args.join(" ")}\n${stderr}`),
    { code: exitCode, killed: false, signal: null, stdout, stderr },
  );
}

function timeoutError(bin: string, args: string[]): Error {
  return Object.assign(new Error(`Command failed: ${bin} ${args.join(" ")}`), {
    code: null,
    killed: true,
    signal: "SIGTERM",
    stdout: "",
    stderr: "",
  });
}

/** What `claude-ide-bridge --version` does on this machine. */
function versionCheck(m: Machine, bin: string, args: string[]): Output | Error {
  if (m.onPath === null) return spawnError("ENOENT", bin);
  switch (m.check) {
    case "ok":
      return { stdout: `claude-ide-bridge ${m.onPath}\n`, stderr: "" };
    case "timeout":
      return timeoutError(bin, args);
    case "exit-1":
      // The message mentions ENOENT on purpose: a bridge that starts and then
      // fails to open a file is installed, not missing.
      return exitError(
        bin,
        args,
        1,
        "",
        "Error: ENOENT: no such file or directory, open 'config.json'",
      );
    case "no-version":
      return { stdout: "", stderr: "" };
    case "eacces":
      return spawnError("EACCES", bin);
    case "einval":
      // Thrown, not returned: Node rejects this spawn before it starts, and
      // does so synchronously.
      throw spawnError("EINVAL", bin);
  }
}

/** What `npm <args>` does on this machine. */
function npm(m: Machine, bin: string, args: string[]): Output | Error {
  if (!m.npmInstalled) return spawnError("ENOENT", bin);
  const command = args[0];
  if (command === "ls") {
    if (m.list === "garbage") {
      return { stdout: "npm warn config something\n", stderr: "" };
    }
    if (m.inNpm === null) {
      // Real npm: exit code 1 and a tree with no dependencies.
      return exitError(
        bin,
        args,
        1,
        `${JSON.stringify({ name: "lib" }, null, 2)}\n`,
      );
    }
    const tree = {
      name: "lib",
      dependencies: { "patchwork-os": { version: m.inNpm, overridden: false } },
    };
    return { stdout: `${JSON.stringify(tree, null, 2)}\n`, stderr: "" };
  }
  if (command === "view") {
    if (m.latest === null) {
      return exitError(bin, args, 1, "", "npm error code ENOTFOUND");
    }
    return { stdout: `${m.latest}\n`, stderr: "" };
  }
  if (command === "install") {
    const prefix = "patchwork-os@";
    const spec =
      args.find((a) => a.startsWith(prefix))?.slice(prefix.length) ?? "";
    const resolved = spec === "latest" ? m.latest : spec;
    if (m.installFails || resolved === null) {
      return exitError(bin, args, 1, "", "npm error network");
    }
    m.installs.push({
      spec,
      resolved,
      replaced: { onPath: m.onPath, inNpm: m.inNpm },
    });
    m.inNpm = resolved;
    if (m.npmBinOnPath) m.onPath = resolved;
    return { stdout: "added 1 package in 2s\n", stderr: "" };
  }
  m.unexpected.push([bin, ...args].join(" "));
  return new Error(`unexpected npm command: ${args.join(" ")}`);
}

/** Point the mocked execFile at a machine. */
function runOn(m: Machine): Machine {
  mockedExecFile.mockImplementation(
    (bin: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      const line = [bin, ...args].join(" ");
      m.commands.push(line);
      let outcome: Output | Error;
      if (bin === BRIDGE_BIN) outcome = versionCheck(m, bin, args);
      else if (bin === NPM_BIN) outcome = npm(m, bin, args);
      else {
        m.unexpected.push(line);
        outcome = new Error(`unexpected command: ${line}`);
      }
      if (outcome instanceof Error) cb(outcome);
      else cb(null, outcome);
    },
  );
  return m;
}

function setBuiltInVersion(version: string): void {
  (globalThis as Record<string, unknown>).BRIDGE_VERSION = version;
}

function logged(): string {
  return output.appendLine.mock.calls.map((c) => String(c[0])).join("\n");
}

describe("BridgeInstaller: a failed version check is not a missing bridge", () => {
  afterEach(() => setBuiltInVersion("2.0.1"));

  it("installs nothing when the check times out and a newer bridge is installed", async () => {
    const m = runOn(machineWith("3.0.0", { check: "timeout" }));

    await installer.ensureInstalled();

    expect(m.installs).toEqual([]);
    expect(m.onPath).toBe("3.0.0");
    expect(m.commands.filter((c) => c.includes(" install "))).toEqual([]);
    // It says so in the output channel …
    expect(logged()).toMatch(/version check/i);
    // … and interrupts nobody: no dialog, no progress, one notice at most.
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(vscode.window.withProgress).not.toHaveBeenCalled();
    expect(
      (vscode.window.setStatusBarMessage as ReturnType<typeof vi.fn>).mock.calls
        .length,
    ).toBeLessThanOrEqual(1);
    expect(m.unexpected).toEqual([]);
  });

  it.each([
    "timeout",
    "exit-1",
    "no-version",
    "eacces",
    "einval",
  ] as const)("installs nothing when the check fails with %s", async (check) => {
    const m = runOn(machineWith("3.0.0", { check }));

    await installer.ensureInstalled();

    expect(m.installs).toEqual([]);
    expect(m.onPath).toBe("3.0.0");
    expect(m.unexpected).toEqual([]);
  });
});

describe("BridgeInstaller: the built-in version is a minimum, not what gets installed", () => {
  afterEach(() => setBuiltInVersion("2.0.1"));

  it("treats a missing binary as not installed and installs patchwork-os@latest", async () => {
    const m = runOn(machine({ onPath: null, inNpm: null, latest: "2.4.0" }));

    await installer.ensureInstalled();

    expect(m.installs.map((i) => i.spec)).toEqual(["latest"]);
    expect(m.commands.at(-1)).toBe(`${NPM_BIN} install -g patchwork-os@latest`);
    // The version that was current when the extension was built is not asked for.
    expect(m.commands.join("\n")).not.toContain("patchwork-os@2.0.1");
    expect(m.onPath).toBe("2.4.0");
    expect(m.unexpected).toEqual([]);
  });

  it("upgrades a version below the minimum to the registry's latest", async () => {
    const m = runOn(machineWith("1.9.0", { latest: "2.4.0" }));

    await installer.ensureInstalled();

    expect(m.installs).toHaveLength(1);
    // Where it lands is whatever `latest` means now, not the built-in 2.0.1.
    expect(m.onPath).toBe("2.4.0");
    expect(m.commands.join("\n")).not.toContain("patchwork-os@2.0.1");
    expect(m.unexpected).toEqual([]);
  });
});

describe("BridgeInstaller: no install lowers what is installed", () => {
  afterEach(() => setBuiltInVersion("2.0.1"));

  // Ascending. The position in this list is the test's own idea of "newer":
  // nothing below compares versions with the installer's code.
  const LADDER = [
    "1.9.0",
    "2.0.0-beta.9",
    "2.0.0-beta.10",
    "2.0.0",
    "2.0.1",
    "2.1.0-canary.5",
    "2.4.0",
    "3.0.0",
  ];
  const rank = (v: string): number => {
    const i = LADDER.indexOf(v);
    if (i === -1) throw new Error(`version outside the ladder: ${v}`);
    return i;
  };

  it("keeps 2.0.0-beta.10 when the built-in version is 2.0.0-beta.9", async () => {
    // "beta.10" sorts before "beta.9" as text. It is the newer one.
    setBuiltInVersion("2.0.0-beta.9");
    const m = runOn(machineWith("2.0.0-beta.10", { latest: "1.9.0" }));

    await installer.ensureInstalled();

    expect(m.installs).toEqual([]);
    expect(m.onPath).toBe("2.0.0-beta.10");
  });

  it("holds for every machine in the grid", async () => {
    const CHECKS: CheckBehaviour[] = [
      "ok",
      "timeout",
      "exit-1",
      "no-version",
      "eacces",
      "einval",
    ];
    const violations: string[] = [];
    let machines = 0;
    let installsSeen = 0;

    for (const minimum of ["2.0.0-beta.9", "2.0.1", "2.4.0"]) {
      setBuiltInVersion(minimum);
      for (const onPath of [null, ...LADDER]) {
        for (const check of onPath === null ? (["ok"] as const) : CHECKS) {
          for (const inNpm of [null, ...LADDER]) {
            for (const list of ["ok", "garbage"] as const) {
              for (const latest of [null, ...LADDER]) {
                for (const npmBinOnPath of [true, false]) {
                  const m = runOn(
                    machine({
                      onPath,
                      check,
                      inNpm,
                      list,
                      latest,
                      npmBinOnPath,
                    }),
                  );
                  const before = { onPath, inNpm };
                  machines++;

                  await new BridgeInstaller(
                    output as unknown as import("vscode").OutputChannel,
                  )
                    .ensureInstalled()
                    .catch(() => {
                      // A failed install is allowed. A lowering one is not,
                      // and that is read off the machine below.
                    });

                  const where = JSON.stringify({ minimum, ...m, commands: 0 });
                  installsSeen += m.installs.length;
                  for (const install of m.installs) {
                    for (const had of [
                      install.replaced.onPath,
                      install.replaced.inNpm,
                    ]) {
                      if (had !== null && rank(install.resolved) <= rank(had)) {
                        violations.push(
                          `installed ${install.resolved} over ${had}: ${where}`,
                        );
                      }
                    }
                  }
                  for (const copy of ["onPath", "inNpm"] as const) {
                    const was = before[copy];
                    const is = m[copy];
                    if (was !== null && (is === null || rank(is) < rank(was))) {
                      violations.push(
                        `${copy} went from ${was} to ${is}: ${where}`,
                      );
                    }
                  }
                  // A check that could not read an existing binary must never
                  // be followed by an install.
                  if (
                    onPath !== null &&
                    check !== "ok" &&
                    m.installs.length > 0
                  ) {
                    violations.push(`installed after a failed check: ${where}`);
                  }
                  if (m.unexpected.length > 0) {
                    violations.push(`ran ${m.unexpected.join("; ")}: ${where}`);
                  }
                }
              }
            }
          }
        }
      }
    }

    expect(violations.slice(0, 5)).toEqual([]);
    expect(violations).toHaveLength(0);
    // The grid must actually exercise installs, or the loop above proves
    // nothing: an installer that never installs passes it trivially.
    expect(machines).toBeGreaterThan(10_000);
    expect(installsSeen).toBeGreaterThan(100);
  }, 60_000);
});
