import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import {
  DB_ALLOWLIST_EXTRAS,
  findEditor,
  ideNameFromEditor,
  parseConfig,
} from "../config.js";

const mockedExecFileSync = vi.mocked(execFileSync);

afterEach(() => {
  vi.clearAllMocks();
});

describe("findEditor", () => {
  it("returns windsurf when it is on the PATH", () => {
    mockedExecFileSync.mockImplementation(() => "");
    expect(findEditor()).toBe("windsurf");
  });

  it("returns cursor when windsurf is not found but cursor is", () => {
    mockedExecFileSync.mockImplementation((_cmd, args) => {
      const target = (args as string[])[0];
      if (target === "windsurf") throw new Error("not found");
      return "";
    });
    expect(findEditor()).toBe("cursor");
  });

  it("returns antigravity when windsurf and cursor are not found", () => {
    mockedExecFileSync.mockImplementation((_cmd, args) => {
      const target = (args as string[])[0];
      if (target === "windsurf" || target === "cursor")
        throw new Error("not found");
      return "";
    });
    expect(findEditor()).toBe("antigravity");
  });

  it("returns ag when windsurf, cursor and antigravity are not found", () => {
    mockedExecFileSync.mockImplementation((_cmd, args) => {
      const target = (args as string[])[0];
      if (["windsurf", "cursor", "antigravity"].includes(target))
        throw new Error("not found");
      return "";
    });
    expect(findEditor()).toBe("ag");
  });

  it("returns code as final fallback", () => {
    mockedExecFileSync.mockImplementation((_cmd, args) => {
      const target = (args as string[])[0];
      if (["windsurf", "cursor", "antigravity", "ag"].includes(target))
        throw new Error("not found");
      return "";
    });
    expect(findEditor()).toBe("code");
  });

  it("returns null when no editor is found", () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(findEditor()).toBeNull();
  });
});

describe("parseConfig --allow-command interpreter guard", () => {
  it("throws when adding an interpreter command via --allow-command", () => {
    expect(() =>
      parseConfig(["--workspace", "/tmp", "--allow-command", "node"]),
    ).toThrow(/interpreter/);
  });

  it("throws for all interpreter commands (bash, python, etc.)", () => {
    for (const cmd of ["bash", "python", "python3", "sh", "ruby", "perl"]) {
      expect(() =>
        parseConfig(["--workspace", "/tmp", "--allow-command", cmd]),
      ).toThrow(/interpreter/);
    }
  });

  it("allows non-interpreter commands via --allow-command", () => {
    const config = parseConfig([
      "--workspace",
      "/tmp",
      "--allow-command",
      "prettier",
    ]);
    expect(config.commandAllowlist).toContain("prettier");
  });
});

// Helper: parseConfig slices argv at index 2, so prefix with two dummy entries
const cfg = (...a: string[]) => parseConfig(["node", "bridge.js", ...a]);

describe("parseConfig flags", () => {
  it.skipIf(process.platform === "win32")(
    "sets workspace from --workspace",
    () => {
      const config = cfg("--workspace", "/my/project");
      expect(config.workspace).toBe("/my/project");
    },
  );

  it("sets ideName from --ide-name", () => {
    const config = cfg("--ide-name", "MyIDE");
    expect(config.ideName).toBe("MyIDE");
  });

  it("throws when --ide-name value is too long", () => {
    expect(() => cfg("--ide-name", "x".repeat(257))).toThrow(/too long/);
  });

  it("sets editorCommand from --editor", () => {
    const config = cfg("--editor", "cursor");
    expect(config.editorCommand).toBe("cursor");
  });

  it("throws when --editor value is too long", () => {
    expect(() => cfg("--editor", "x".repeat(4097))).toThrow(/too long/);
  });

  it("sets bindAddress from --bind", () => {
    const config = cfg("--bind", "0.0.0.0");
    expect(config.bindAddress).toBe("0.0.0.0");
  });

  it("throws when --bind value is too long", () => {
    expect(() => cfg("--bind", "x".repeat(65))).toThrow(/too long/);
  });

  it("sets port from --port", () => {
    const config = cfg("--port", "8080");
    expect(config.port).toBe(8080);
  });

  it("throws on invalid port below 1024", () => {
    expect(() => cfg("--port", "80")).toThrow(/Invalid port/);
  });

  it("throws on invalid port above 65535", () => {
    expect(() => cfg("--port", "70000")).toThrow(/Invalid port/);
  });

  it("throws on non-integer port", () => {
    expect(() => cfg("--port", "abc")).toThrow(/Invalid port/);
  });

  it("sets verbose from --verbose", () => {
    expect(cfg("--verbose").verbose).toBe(true);
  });

  it("sets jsonl from --jsonl", () => {
    expect(cfg("--jsonl").jsonl).toBe(true);
  });

  it("adds linter from --linter", () => {
    expect(cfg("--linter", "eslint").linters).toContain("eslint");
  });

  it("throws when --linter value too long", () => {
    expect(() => cfg("--linter", "x".repeat(257))).toThrow(/too long/);
  });

  it("adds vscode command from --vscode-allow-command", () => {
    expect(
      cfg("--vscode-allow-command", "myExt.cmd").vscodeCommandAllowlist,
    ).toContain("myExt.cmd");
  });

  it("throws when --vscode-allow-command value too long", () => {
    expect(() => cfg("--vscode-allow-command", "x".repeat(257))).toThrow(
      /too long/,
    );
  });

  it("sets commandTimeout from --timeout", () => {
    expect(cfg("--timeout", "5000").commandTimeout).toBe(5000);
  });

  it("throws on --timeout below 1000", () => {
    expect(() => cfg("--timeout", "500")).toThrow(/Invalid timeout/);
  });

  it("accepts --timeout up to 600000", () => {
    expect(cfg("--timeout", "600000").commandTimeout).toBe(600000);
  });

  it("throws on --timeout above 600000", () => {
    expect(() => cfg("--timeout", "700000")).toThrow(/Invalid timeout/);
  });

  it("sets autoTmux from --auto-tmux", () => {
    expect(cfg("--auto-tmux").autoTmux).toBe(true);
  });

  it("sets gracePeriodMs from --grace-period", () => {
    expect(cfg("--grace-period", "10000").gracePeriodMs).toBe(10000);
  });

  it("throws on --grace-period below 5000", () => {
    expect(() => cfg("--grace-period", "1000")).toThrow(/Invalid grace-period/);
  });

  it("throws on --grace-period above 600000", () => {
    expect(() => cfg("--grace-period", "700000")).toThrow(
      /Invalid grace-period/,
    );
  });

  it("sets maxResultSize from --max-result-size", () => {
    expect(cfg("--max-result-size", "1024").maxResultSize).toBe(1024);
  });

  it("throws on --max-result-size below 1", () => {
    expect(() => cfg("--max-result-size", "0")).toThrow(
      /Invalid max-result-size/,
    );
  });

  it("throws on --max-result-size above 4096", () => {
    expect(() => cfg("--max-result-size", "5000")).toThrow(
      /Invalid max-result-size/,
    );
  });

  it("adds plugin path from --plugin", () => {
    expect(cfg("--plugin", "/path/to/my-plugin").plugins).toContain(
      "/path/to/my-plugin",
    );
  });

  it("accumulates multiple --plugin flags", () => {
    expect(cfg("--plugin", "/a", "--plugin", "/b").plugins).toEqual([
      "/a",
      "/b",
    ]);
  });

  it("throws when --plugin path is too long", () => {
    expect(() => cfg("--plugin", "x".repeat(4097))).toThrow(/too long/);
  });

  it("defaults plugins to empty array", () => {
    expect(cfg().plugins).toEqual([]);
  });

  it("throws on unknown flag", () => {
    expect(() => cfg("--unknown-flag")).toThrow(/Unknown option/);
  });

  it("throws when flag value is missing (no next arg)", () => {
    expect(() => cfg("--workspace")).toThrow(/Missing value/);
  });

  it("throws when flag value starts with --", () => {
    expect(() => cfg("--workspace", "--other")).toThrow(/Missing value/);
  });
});

describe("ideNameFromEditor", () => {
  it("maps windsurf -> Windsurf", () => {
    expect(ideNameFromEditor("windsurf")).toBe("Windsurf");
  });

  it("maps cursor -> Cursor", () => {
    expect(ideNameFromEditor("cursor")).toBe("Cursor");
  });

  it("maps antigravity -> Antigravity", () => {
    expect(ideNameFromEditor("antigravity")).toBe("Antigravity");
  });

  it("maps ag -> Antigravity", () => {
    expect(ideNameFromEditor("ag")).toBe("Antigravity");
  });

  it("maps code -> VS Code", () => {
    expect(ideNameFromEditor("code")).toBe("VS Code");
  });

  it("falls back to the editor command for unknown editors", () => {
    expect(ideNameFromEditor("myeditor")).toBe("myeditor");
  });
});

describe("parseConfig --db flag", () => {
  it("adds all DB commands to the allowlist when --db is set", () => {
    const config = cfg("--db");
    for (const cmd of DB_ALLOWLIST_EXTRAS) {
      expect(config.commandAllowlist).toContain(cmd);
    }
  });

  it("sets db to true when --db is set", () => {
    expect(cfg("--db").db).toBe(true);
  });

  it("defaults db to false", () => {
    expect(cfg().db).toBe(false);
  });

  it("does not include DB commands by default", () => {
    const config = cfg();
    expect(config.commandAllowlist).not.toContain("psql");
    expect(config.commandAllowlist).not.toContain("pg_dump");
    expect(config.commandAllowlist).not.toContain("mysql");
  });

  it("combines with --vps", () => {
    const config = cfg("--vps", "--db");
    expect(config.commandAllowlist).toContain("psql");
    expect(config.commandAllowlist).toContain("curl");
    expect(config.commandAllowlist).toContain("docker");
  });
});

describe("parseConfig --allow-private-http flag", () => {
  it("sets allowPrivateHttp to true when --allow-private-http is set", () => {
    expect(cfg("--allow-private-http").allowPrivateHttp).toBe(true);
  });

  it("defaults allowPrivateHttp to false", () => {
    expect(cfg().allowPrivateHttp).toBe(false);
  });
});

describe("parseConfig expanded VPS extras", () => {
  it("includes new diagnostic/admin tools in VPS allowlist", () => {
    const config = cfg("--vps");
    for (const cmd of [
      "docker-compose",
      "certbot",
      "ufw",
      "htop",
      "top",
      "ss",
      "lsof",
      "tar",
      "gzip",
      "gunzip",
      "rsync",
      "dig",
      "openssl",
    ]) {
      expect(config.commandAllowlist).toContain(cmd);
    }
  });

  it("still includes original VPS commands", () => {
    const config = cfg("--vps");
    for (const cmd of [
      "curl",
      "systemctl",
      "journalctl",
      "service",
      "nginx",
      "pm2",
      "docker",
    ]) {
      expect(config.commandAllowlist).toContain(cmd);
    }
  });
});
