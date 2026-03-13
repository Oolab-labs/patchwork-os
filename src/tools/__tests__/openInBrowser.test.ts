import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock fs/promises
vi.mock("node:fs/promises", () => ({
  default: {
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock execSafe
vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return {
    ...actual,
    execSafe: vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      durationMs: 5,
    }),
  };
});

import fs from "node:fs/promises";
import { execSafe } from "../utils.js";
import { createOpenInBrowserTool } from "../openInBrowser.js";

describe("createOpenInBrowserTool", () => {
  const tool = createOpenInBrowserTool();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes to tmpdir with default filename and opens with `open` on darwin", async () => {
    const html = "<html><body>Hello</body></html>";
    const result = await tool.handler({ html });

    expect(fs.writeFile).toHaveBeenCalledOnce();
    const [writtenPath, writtenContent, encoding] = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(writtenPath).toMatch(/^\/.*\/report-\d+\.html$/);
    expect(writtenPath.startsWith(os.tmpdir())).toBe(true);
    expect(writtenContent).toBe(html);
    expect(encoding).toBe("utf8");

    expect(execSafe).toHaveBeenCalledWith("open", [writtenPath]);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.path).toBe(writtenPath);
  });

  it("uses the provided filename when valid", async () => {
    const html = "<html><body>Report</body></html>";
    const result = await tool.handler({ html, filename: "my-report.html" });

    const [writtenPath] = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(writtenPath).toBe(path.join(os.tmpdir(), "my-report.html"));

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.path).toBe(writtenPath);
  });

  it("sanitizes path traversal in filename to a safe default", async () => {
    const html = "<html><body>x</body></html>";
    await tool.handler({ html, filename: "../../etc/passwd.html" });

    const [writtenPath] = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls[0];
    // Should NOT contain ".." and should be in tmpdir
    expect(writtenPath).not.toContain("..");
    expect(writtenPath.startsWith(os.tmpdir())).toBe(true);
    expect(path.basename(writtenPath)).toMatch(/^report-\d+\.html$/);
  });

  it("falls back to default filename when filename does not end in .html", async () => {
    const html = "<html><body>x</body></html>";
    await tool.handler({ html, filename: "report.txt" });

    const [writtenPath] = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path.basename(writtenPath)).toMatch(/^report-\d+\.html$/);
  });

  it("uses xdg-open on linux", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const html = "<html></html>";
    await tool.handler({ html });

    expect(execSafe).toHaveBeenCalledWith("xdg-open", [expect.stringMatching(/\.html$/)]);
  });

  it("uses cmd /c start on win32", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const html = "<html></html>";
    await tool.handler({ html });

    expect(execSafe).toHaveBeenCalledWith("cmd", ["/c", "start", "", expect.stringMatching(/\.html$/)]);
  });
});
