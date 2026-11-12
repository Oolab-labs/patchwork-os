import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const BRIDGE_BIN =
  process.platform === "win32" ? "claude-ide-bridge.cmd" : "claude-ide-bridge";
const NPM_BIN = process.platform === "win32" ? "npm.cmd" : "npm";

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

// The installer reads MIN_BRIDGE_VERSION as a free identifier: esbuild inlines
// it in a real build, and here it is a global. Set before the import below.
(globalThis as Record<string, unknown>).MIN_BRIDGE_VERSION = "2.0.1";

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { BridgeInstaller, compareVersions } from "../bridgeInstaller";

const mockedExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

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

// ─────────────────────────────────────────────────────────────────────────────
// The installer must never leave a machine with an older bridge than it found.
//
// These tests do not assert on call shapes alone. They run the installer
// against a stand-in for the machine, which knows the TRUE installed version
// even when the installer's own version check cannot read it, and then look at
// what is installed afterwards.
// ─────────────────────────────────────────────────────────────────────────────

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
  /**
   * What is on disk in npm's global directory. "plain": the manifest of the
   * copy `inNpm` names, or nothing when there is none. "garbled": a manifest
   * that cannot be parsed. "no-answer": npm will not say where the directory
   * is.
   */
  disk: "plain" | "garbled" | "no-answer";
  /** Overrides what `npm root -g` prints. */
  npmRoot?: string;
  /** What the registry's `latest` tag points at; null = registry unreachable. */
  latest: string | null;
  /** If set, `latest` moves here right after it has been looked up. */
  latestAfterLookup?: string;
  npmInstalled: boolean;
  /** The copy on PATH is npm's copy (the usual case). */
  npmBinOnPath: boolean;
  installFails: boolean;
  installs: Install[];
  commands: string[];
  unexpected: string[];
}

// The installer reads the copy in npm's global directory from disk, so the
// stand-in needs real directories behind `npm root -g`: one per version, one
// that is empty, one whose manifest is not a manifest.
const ROOTS = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-installer-roots-"));

afterAll(() => {
  fs.rmSync(ROOTS, { recursive: true, force: true });
});

/** A global directory that does not exist: npm has never installed there. */
const NO_SUCH_DIR = path.join(ROOTS, "never-created", "lib", "node_modules");

function writeManifest(root: string, text: string): string {
  fs.mkdirSync(path.join(root, "patchwork-os"), { recursive: true });
  fs.writeFileSync(path.join(root, "patchwork-os", "package.json"), text);
  return root;
}

const roots = new Map<string, string>();

/** A real directory holding exactly what this machine says npm has. */
function rootFor(m: Machine): string {
  const key = m.disk === "garbled" ? "garbled" : (m.inNpm ?? "empty");
  let root = roots.get(key);
  if (root === undefined) {
    root = path.join(ROOTS, `root-${roots.size}`);
    fs.mkdirSync(root, { recursive: true });
    if (m.disk === "garbled") {
      writeManifest(root, "{ this is not a manifest");
    } else if (m.inNpm !== null) {
      writeManifest(
        root,
        JSON.stringify({ name: "patchwork-os", version: m.inNpm }),
      );
    }
    roots.set(key, root);
  }
  return root;
}

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    onPath: null,
    check: "ok",
    inNpm: null,
    disk: "plain",
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
  if (command === "root") {
    if (m.disk === "no-answer") {
      return exitError(
        bin,
        args,
        1,
        "",
        "npm error code ENOENT\nnpm error syscall uv_cwd",
      );
    }
    return { stdout: `${m.npmRoot ?? rootFor(m)}\n`, stderr: "" };
  }
  if (command === "view") {
    if (m.latest === null) {
      return exitError(bin, args, 1, "", "npm error code ENOTFOUND");
    }
    const answer = { stdout: `${m.latest}\n`, stderr: "" };
    if (m.latestAfterLookup !== undefined) m.latest = m.latestAfterLookup;
    return answer;
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

function setBuiltInVersion(version: string | undefined): void {
  (globalThis as Record<string, unknown>).MIN_BRIDGE_VERSION = version;
}

const statusBar = () =>
  vscode.window.setStatusBarMessage as ReturnType<typeof vi.fn>;

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

  it.each([
    "timeout",
    "exit-1",
    "no-version",
    "eacces",
  ] as const)("stops at a check that fails with %s, even when npm knows of no copy", async (check) => {
    // This bridge came from somewhere npm's global directory does not cover,
    // so asking npm would not have revealed it. The failed check alone has to
    // be enough to stop.
    const m = runOn(
      machine({ onPath: "3.0.0", inNpm: null, npmBinOnPath: false, check }),
    );

    await installer.ensureInstalled();

    expect(m.commands).toEqual([`${BRIDGE_BIN} --version`]);
    expect(m.installs).toEqual([]);
    expect(statusBar()).toHaveBeenCalledTimes(1);
    expect(statusBar().mock.calls[0][0]).toMatch(/could not check/);
  });

  it("stops at a check Node refuses to start, and logs it without a notice", async () => {
    // EINVAL is what every check gets on Windows, installed or not. It will
    // be the same on the next start, so it belongs in the log and nowhere
    // more visible.
    const m = runOn(
      machine({
        onPath: "3.0.0",
        inNpm: null,
        npmBinOnPath: false,
        check: "einval",
      }),
    );

    await installer.ensureInstalled();

    expect(m.commands).toEqual([`${BRIDGE_BIN} --version`]);
    expect(m.installs).toEqual([]);
    expect(logged()).toMatch(/cannot be checked on this system/);
    expect(logged()).toContain("npm install -g patchwork-os@latest");
    expect(statusBar()).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
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
            for (const disk of ["plain", "garbled", "no-answer"] as const) {
              for (const latest of [null, ...LADDER]) {
                for (const npmBinOnPath of [true, false]) {
                  const m = runOn(
                    machine({
                      onPath,
                      check,
                      inNpm,
                      disk,
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

describe("BridgeInstaller.probeInstalled", () => {
  it("reads the version the binary prints", async () => {
    const m = runOn(machineWith("2.0.0"));

    expect(await installer.probeInstalled()).toEqual({
      kind: "installed",
      version: "2.0.0",
    });
    expect(m.commands).toEqual([`${BRIDGE_BIN} --version`]);
  });

  it("keeps a pre-release version whole", async () => {
    runOn(machineWith("1.2.8-canary.1015"));

    expect(await installer.probeInstalled()).toEqual({
      kind: "installed",
      version: "1.2.8-canary.1015",
    });
  });

  it("reports a binary that is not on PATH as missing", async () => {
    runOn(machine({ onPath: null }));

    expect(await installer.probeInstalled()).toEqual({ kind: "missing" });
  });

  it.each([
    "timeout",
    "exit-1",
    "no-version",
    "eacces",
    "einval",
  ] as const)("reports a check that fails with %s as unknown, never missing", async (check) => {
    runOn(machineWith("3.0.0", { check }));

    const found = await installer.probeInstalled();

    expect(found.kind).toBe("unknown");
    expect(found).toHaveProperty("reason");
    // Only a spawn Node refuses outright is marked as one that will repeat.
    expect("refused" in found).toBe(check === "einval");
  });

  it("goes by the error code, not by a message that says ENOENT", async () => {
    // A bare Error whose text is "ENOENT" and which carries no code — the
    // shape these tests used to pass off as "binary not found". Node never
    // reports a missing binary this way.
    mockedExecFile.mockImplementationOnce(
      (_bin: string, _args: string[], _opts: unknown, cb: ExecCallback) =>
        cb(new Error("ENOENT")),
    );

    expect((await installer.probeInstalled()).kind).toBe("unknown");
  });
});

describe("BridgeInstaller.getMinimumVersion", () => {
  afterEach(() => setBuiltInVersion("2.0.1"));

  it("returns the version the extension was built against", () => {
    expect(installer.getMinimumVersion()).toBe("2.0.1");
  });

  it("is 0.0.0 when the build constant is absent (a development run)", () => {
    setBuiltInVersion(undefined);

    expect(installer.getMinimumVersion()).toBe("0.0.0");
  });

  it("is 0.0.0 when the build constant is not a version", () => {
    setBuiltInVersion("not-a-version");

    expect(installer.getMinimumVersion()).toBe("0.0.0");
  });
});

describe("BridgeInstaller: when there is nothing to do", () => {
  afterEach(() => setBuiltInVersion("2.0.1"));

  it("runs the version check and nothing else when the minimum is met", async () => {
    const m = runOn(machineWith("2.0.1"));

    await installer.ensureInstalled();

    expect(m.commands).toEqual([`${BRIDGE_BIN} --version`]);
    expect(vscode.window.withProgress).not.toHaveBeenCalled();
    expect(statusBar()).not.toHaveBeenCalled();
  });

  it("leaves a bridge that is newer than npm's latest alone", async () => {
    const m = runOn(machineWith("3.0.0", { latest: "2.4.0" }));

    await installer.ensureInstalled();

    expect(m.commands).toEqual([`${BRIDGE_BIN} --version`]);
    expect(m.onPath).toBe("3.0.0");
  });

  it("with no build constant, leaves any installed bridge alone", async () => {
    setBuiltInVersion(undefined);
    const m = runOn(machineWith("0.0.1", { latest: "2.4.0" }));

    await installer.ensureInstalled();

    expect(m.installs).toEqual([]);
  });
});

describe("BridgeInstaller: what npm holds counts as much as what PATH finds", () => {
  afterEach(() => setBuiltInVersion("2.0.1"));

  it("does not install over a newer copy that is simply not on PATH", async () => {
    // The binary is missing from this editor's PATH, but npm's global
    // directory holds 3.0.0. `npm install -g patchwork-os@latest` would
    // replace it with 2.4.0.
    const m = runOn(machine({ onPath: null, inNpm: "3.0.0", latest: "2.4.0" }));

    await installer.ensureInstalled();

    expect(m.installs).toEqual([]);
    expect(m.inNpm).toBe("3.0.0");
    expect(logged()).toMatch(/not on this editor's PATH/);
    expect(statusBar()).toHaveBeenCalledTimes(1);
  });

  it("upgrades a copy below the minimum that PATH does not find", async () => {
    const m = runOn(machine({ onPath: null, inNpm: "1.9.0", latest: "2.4.0" }));

    await installer.ensureInstalled();

    expect(m.installs.map((i) => i.resolved)).toEqual(["2.4.0"]);
    expect(m.inNpm).toBe("2.4.0");
  });

  it("does not touch npm's newer copy when an older one comes first on PATH", async () => {
    const m = runOn(
      machine({
        onPath: "1.9.0",
        inNpm: "3.0.0",
        npmBinOnPath: false,
        latest: "2.4.0",
      }),
    );

    await installer.ensureInstalled();

    expect(m.installs).toEqual([]);
    expect(m.inNpm).toBe("3.0.0");
    expect(logged()).toMatch(/comes first on this editor's PATH/);
  });

  it("installs nothing when the copy in npm's directory cannot be read", async () => {
    const m = runOn(machine({ onPath: null, inNpm: "3.0.0", disk: "garbled" }));

    await installer.ensureInstalled();

    expect(m.installs).toEqual([]);
    expect(m.inNpm).toBe("3.0.0");
    expect(statusBar()).toHaveBeenCalledTimes(1);
  });

  it("installs nothing when npm will not say where its global directory is", async () => {
    const m = runOn(
      machine({ onPath: null, inNpm: "3.0.0", disk: "no-answer" }),
    );

    await installer.ensureInstalled();

    expect(m.installs).toEqual([]);
    expect(m.inNpm).toBe("3.0.0");
  });

  it("installs when npm has never held a global package", async () => {
    // A prefix that has never had a global install has no directory at all.
    // Nothing is installed there, so this is a first install like any other.
    const m = runOn(
      machine({ onPath: null, inNpm: null, npmRoot: NO_SUCH_DIR }),
    );

    await installer.ensureInstalled();

    expect(m.commands).toEqual([
      `${BRIDGE_BIN} --version`,
      `${NPM_BIN} root -g`,
      `${NPM_BIN} install -g patchwork-os@latest`,
    ]);
    expect(m.onPath).toBe("2.4.0");
    expect(m.unexpected).toEqual([]);
  });

  it("installs over a leftover folder that has no manifest", async () => {
    // What an install that was stopped half-way leaves behind. It is not a
    // copy: there is no version in it to lower, and installing repairs it.
    const leftover = path.join(ROOTS, "leftover");
    fs.mkdirSync(path.join(leftover, "patchwork-os", "dist"), {
      recursive: true,
    });
    const m = runOn(machine({ onPath: null, inNpm: null, npmRoot: leftover }));

    await installer.ensureInstalled();

    expect(m.installs.map((i) => i.spec)).toEqual(["latest"]);
  });

  it("installs nothing when npm names a directory that is not a full path", async () => {
    const m = runOn(
      machine({ onPath: null, inNpm: "3.0.0", npmRoot: "node_modules" }),
    );

    await installer.ensureInstalled();

    expect(m.installs).toEqual([]);
  });
});

describe("BridgeInstaller: an upgrade installs the release it compared", () => {
  afterEach(() => setBuiltInVersion("2.0.1"));

  it("asks npm for the exact version the registry reported", async () => {
    const m = runOn(machineWith("1.9.0", { latest: "2.4.0" }));

    await installer.ensureInstalled();

    expect(m.commands).toEqual([
      `${BRIDGE_BIN} --version`,
      `${NPM_BIN} root -g`,
      `${NPM_BIN} view patchwork-os@latest version`,
      `${NPM_BIN} install -g patchwork-os@2.4.0`,
    ]);
  });

  it("is not lowered when `latest` moves between the lookup and the install", async () => {
    // 2.0.0 is below the minimum and `latest` says 2.4.0, so an upgrade is
    // right. Then the tag is moved back to 1.9.0. An install of
    // `patchwork-os@latest` would now fetch 1.9.0.
    const m = runOn(
      machineWith("2.0.0", { latest: "2.4.0", latestAfterLookup: "1.9.0" }),
    );

    await installer.ensureInstalled();

    expect(m.onPath).toBe("2.4.0");
  });

  it("installs nothing when the latest release cannot be read", async () => {
    const m = runOn(machineWith("1.9.0", { latest: null }));

    await expect(installer.ensureInstalled()).resolves.toBeUndefined();

    expect(m.installs).toEqual([]);
    expect(m.commands.some((c) => c.includes(" install "))).toBe(false);
    expect(statusBar()).toHaveBeenCalledTimes(1);
  });

  it("installs nothing when npm's latest is what is already installed", async () => {
    const m = runOn(machineWith("2.0.0", { latest: "2.0.0" }));

    await installer.ensureInstalled();

    expect(m.installs).toEqual([]);
    expect(m.commands.some((c) => c.includes(" install "))).toBe(false);
  });

  it("installs nothing when the registry's answer is not a version", async () => {
    // Whatever comes back becomes part of an npm argument, so anything that
    // is not exactly a version is dropped.
    const m = runOn(machineWith("1.9.0", { latest: "2.4.0 --registry=x" }));

    await installer.ensureInstalled();

    expect(m.commands.some((c) => c.includes(" install "))).toBe(false);
    // It is dropped where it is read: not compared, not repeated in the log.
    expect(logged()).toMatch(/could not be read from the npm registry/);
    expect(logged()).not.toContain("--registry=x");
  });

  it("accepts a quoted version, as npm prints it in JSON mode", async () => {
    const m = runOn(machineWith("1.9.0", { latest: '"2.4.0"' }));

    await installer.ensureInstalled();

    expect(m.commands.at(-1)).toBe(`${NPM_BIN} install -g patchwork-os@2.4.0`);
  });
});

describe("BridgeInstaller: when npm cannot do it", () => {
  it("warns once, with the manual command, when npm is not installed", async () => {
    const m = runOn(machine({ onPath: null, npmInstalled: false }));

    await expect(installer.ensureInstalled()).rejects.toThrow(/npm not found/);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(
      (vscode.window.showWarningMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][0],
    ).toContain("npm install -g patchwork-os");
    expect(m.installs).toEqual([]);
  });

  it("reports a failed install as an error for the caller to log", async () => {
    runOn(machine({ onPath: null, installFails: true }));

    await expect(installer.ensureInstalled()).rejects.toThrow(
      /npm install failed/,
    );
    // npm was found, so this is not the "npm is required" case.
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it("shows progress in the status bar while an install runs", async () => {
    runOn(machine({ onPath: null }));

    await installer.ensureInstalled();

    expect(vscode.window.withProgress).toHaveBeenCalledTimes(1);
  });
});

describe("compareVersions", () => {
  // Ascending, including the ordering the SemVer specification gives as its
  // own example for pre-releases.
  const ASCENDING = [
    "0.9.9",
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
    "1.0.1",
    "1.2.0-canary.5",
    "1.2.0-canary.1015",
    "1.2.0",
    "1.10.0",
    "2.0.0",
  ];

  it("orders every pair the way the list is written", () => {
    for (let i = 0; i < ASCENDING.length; i++) {
      for (let j = 0; j < ASCENDING.length; j++) {
        const a = ASCENDING[i] as string;
        const b = ASCENDING[j] as string;
        const order = compareVersions(a, b);
        expect({ a, b, order }).toEqual({ a, b, order: Math.sign(i - j) });
      }
    }
  });

  it("ignores build metadata", () => {
    expect(compareVersions("1.2.3+build.5", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3-rc.1+build.5", "1.2.3-rc.1")).toBe(0);
  });

  it.each([
    "",
    "latest",
    "1.2",
    "1.2.3.4",
    "v1.2.3",
    "1.2.3 --registry=x",
    "1.2.3-",
    `1.2.3-${"a".repeat(80)}`,
  ])("cannot tell when a side is not a version: %j", (notAVersion) => {
    expect(compareVersions(notAVersion, "1.2.3")).toBeNull();
    expect(compareVersions("1.2.3", notAVersion)).toBeNull();
  });
});
