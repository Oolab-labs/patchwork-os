import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CommandConfig } from "../commandDescription.js";
import { buildCommandDescription } from "../commandDescription.js";

let workspace: string;

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cmddesc-test-"));
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

const config: CommandConfig = {
  commandAllowlist: ["npm", "git", "tsc", "node", "make", "curl", "psql"],
  commandTimeout: 30_000,
  maxResultSize: 512, // KB
};

function build(rawArgs: Record<string, unknown>, cfg = config) {
  return buildCommandDescription(rawArgs, cfg, workspace);
}

describe("buildCommandDescription — happy path", () => {
  it("returns command descriptor for valid allowlisted command", () => {
    const desc = build({ command: "npm", args: ["install"] });
    expect(desc.command).toBe("npm");
    expect(desc.args).toEqual(["install"]);
    expect(desc.cwd).toBe(workspace);
    expect(desc.timeout).toBe(config.commandTimeout);
    expect(desc.maxBuffer).toBe(config.maxResultSize * 1024);
  });

  it("lowercases the command name", () => {
    const desc = build({ command: "NPM", args: [] });
    expect(desc.command).toBe("npm");
  });

  it("uses provided timeout within valid range", () => {
    const desc = build({ command: "npm", args: [], timeout: 5000 });
    expect(desc.timeout).toBe(5000);
  });

  it("resolves cwd to workspace when cwd equals workspace", () => {
    const desc = build({ command: "npm", args: [], cwd: workspace });
    expect(desc.cwd).toBe(workspace);
  });

  it("handles empty args array", () => {
    const desc = build({ command: "npm", args: [] });
    expect(desc.args).toEqual([]);
  });

  it("handles missing args (defaults to [])", () => {
    const desc = build({ command: "npm" });
    expect(desc.args).toEqual([]);
  });
});

describe("buildCommandDescription — allowlist enforcement", () => {
  it("throws when command not in allowlist", () => {
    expect(() => build({ command: "rm" })).toThrow(
      'Command "rm" is not in the allowlist',
    );
  });

  it("throws when command contains path separator /", () => {
    expect(() => build({ command: "/bin/rm" })).toThrow(
      "must be a simple basename",
    );
  });

  it("throws when command contains path separator \\", () => {
    expect(() => build({ command: "bin\\rm" })).toThrow(
      "must be a simple basename",
    );
  });

  it("throws when command contains ..", () => {
    expect(() => build({ command: "../npm" })).toThrow(
      "must be a simple basename",
    );
  });

  it("throws when command contains spaces", () => {
    expect(() => build({ command: "npm install" })).toThrow(
      "must be a simple basename",
    );
  });
});

describe("buildCommandDescription — interpreter flag blocklist", () => {
  it("blocks --eval for node", () => {
    expect(() => build({ command: "node", args: ["--eval", "code"] })).toThrow(
      '"--eval" is blocked for interpreter command "node"',
    );
  });

  it("blocks --eval= form for node", () => {
    expect(() =>
      build({ command: "node", args: ["--eval=require('child_process')"] }),
    ).toThrow("--eval");
  });

  it("blocks --inspect for node", () => {
    expect(() => build({ command: "node", args: ["--inspect"] })).toThrow(
      '"--inspect" is blocked',
    );
  });

  it("allows safe node args", () => {
    const desc = build({ command: "node", args: ["--version"] });
    expect(desc.args).toContain("--version");
  });
});

describe("buildCommandDescription — path flag blocklist", () => {
  it("blocks --config for npm", () => {
    expect(() =>
      build({ command: "npm", args: ["--config", "/etc/npm"] }),
    ).toThrow('"--config" is blocked');
  });

  it("allows --config for psql (exempted)", () => {
    const desc = build({ command: "psql", args: ["--config", "myservice"] });
    expect(desc.args).toContain("--config");
  });

  it("blocks -o for curl (output redirect)", () => {
    expect(() => build({ command: "curl", args: ["-o", "/tmp/out"] })).toThrow(
      '"-o" is blocked',
    );
  });

  it("blocks --unix-socket for curl", () => {
    expect(() =>
      build({
        command: "curl",
        args: ["--unix-socket", "/var/run/docker.sock"],
      }),
    ).toThrow('"--unix-socket" is blocked');
  });
});

describe("buildCommandDescription — per-command flag blocklist", () => {
  it("blocks -f for make (Makefile redirection)", () => {
    expect(() =>
      build({ command: "make", args: ["-f", "/tmp/evil.mk"] }),
    ).toThrow('"-f" is blocked for command "make"');
  });

  it("blocks -w for curl (write-out)", () => {
    expect(() =>
      build({ command: "curl", args: ["-w", "%output{/tmp/out}"] }),
    ).toThrow('"-w" is blocked for command "curl"');
  });

  it("allows -w for non-curl commands (not in per-command list)", () => {
    // npm doesn't have -w in per-command blocklist
    // (It might be blocked by path flags but -w isn't in DANGEROUS_PATH_FLAGS either)
    const desc = build({ command: "npm", args: ["-w", "workspace"] });
    expect(desc.args).toContain("-w");
  });
});

describe("buildCommandDescription — path traversal guard", () => {
  it("blocks absolute path args outside workspace", () => {
    expect(() => build({ command: "npm", args: ["/etc/passwd"] })).toThrow(
      "is an absolute path outside the workspace",
    );
  });

  it("blocks absolute path args with leading / outside workspace", () => {
    expect(() => build({ command: "npm", args: ["/etc/shadow"] })).toThrow(
      "is an absolute path outside the workspace",
    );
  });

  it("allows relative path args", () => {
    const desc = build({ command: "npm", args: ["./src/index.ts"] });
    expect(desc.args).toContain("./src/index.ts");
  });

  it("allows absolute paths inside workspace", () => {
    // Create a real file inside workspace so resolveFilePath can lstat it
    const filePath = path.join(workspace, "package.json");
    fs.writeFileSync(filePath, "{}");
    const desc = build({ command: "npm", args: [filePath] });
    expect(desc.args).toContain(filePath);
  });
});

describe("buildCommandDescription — arg validation", () => {
  it("throws when args is not an array", () => {
    expect(() => build({ command: "npm", args: "install" })).toThrow(
      "args must be an array",
    );
  });

  it("throws when arg is not a string", () => {
    expect(() => build({ command: "npm", args: [123] })).toThrow(
      "args[0] must be a string",
    );
  });

  it("throws when too many args", () => {
    const manyArgs = Array.from({ length: 101 }, (_, i) => String(i));
    expect(() => build({ command: "npm", args: manyArgs })).toThrow(
      "args exceeds maximum length",
    );
  });
});
