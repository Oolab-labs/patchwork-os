import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureCmdShim } from "../winShim.js";

const ORIG_PLATFORM = process.platform;

function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

describe("ensureCmdShim", () => {
  describe("on non-win32", () => {
    beforeAll(() => setPlatform("linux"));
    afterAll(() => setPlatform(ORIG_PLATFORM));

    it("returns binary unchanged regardless of shape", () => {
      expect(ensureCmdShim("claude")).toBe("claude");
      expect(ensureCmdShim("/usr/local/bin/claude")).toBe(
        "/usr/local/bin/claude",
      );
      expect(ensureCmdShim("./scripts/foo.sh")).toBe("./scripts/foo.sh");
    });
  });

  describe("on win32", () => {
    beforeAll(() => setPlatform("win32"));
    afterAll(() => setPlatform(ORIG_PLATFORM));

    it("appends .cmd to bare binary names", () => {
      expect(ensureCmdShim("claude")).toBe("claude.cmd");
      expect(ensureCmdShim("claude-ide-bridge")).toBe("claude-ide-bridge.cmd");
      expect(ensureCmdShim("gemini")).toBe("gemini.cmd");
    });

    it("leaves names that already have an extension alone", () => {
      expect(ensureCmdShim("claude.exe")).toBe("claude.exe");
      expect(ensureCmdShim("claude.cmd")).toBe("claude.cmd");
      expect(ensureCmdShim("claude.bat")).toBe("claude.bat");
    });

    it("leaves absolute Windows paths alone", () => {
      // path.sep on win32 is '\'; on the host (darwin/linux) it's '/'. Both
      // backslash-containing and forward-slash-containing paths must be left
      // untouched regardless of host so cross-platform tests stay green.
      expect(ensureCmdShim("C:\\Program Files\\nodejs\\claude")).toBe(
        "C:\\Program Files\\nodejs\\claude",
      );
      expect(ensureCmdShim("C:/Users/foo/claude")).toBe("C:/Users/foo/claude");
    });

    it("leaves relative paths alone", () => {
      expect(ensureCmdShim("./bin/claude")).toBe("./bin/claude");
      expect(ensureCmdShim(".\\bin\\claude")).toBe(".\\bin\\claude");
    });
  });
});
