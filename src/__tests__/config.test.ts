import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { findEditor, ideNameFromEditor } from "../config.js";

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
      if (target === "windsurf" || target === "cursor") throw new Error("not found");
      return "";
    });
    expect(findEditor()).toBe("antigravity");
  });

  it("returns ag when windsurf, cursor and antigravity are not found", () => {
    mockedExecFileSync.mockImplementation((_cmd, args) => {
      const target = (args as string[])[0];
      if (["windsurf", "cursor", "antigravity"].includes(target)) throw new Error("not found");
      return "";
    });
    expect(findEditor()).toBe("ag");
  });

  it("returns code as final fallback", () => {
    mockedExecFileSync.mockImplementation((_cmd, args) => {
      const target = (args as string[])[0];
      if (["windsurf", "cursor", "antigravity", "ag"].includes(target)) throw new Error("not found");
      return "";
    });
    expect(findEditor()).toBe("code");
  });

  it("returns null when no editor is found", () => {
    mockedExecFileSync.mockImplementation(() => { throw new Error("not found"); });
    expect(findEditor()).toBeNull();
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
