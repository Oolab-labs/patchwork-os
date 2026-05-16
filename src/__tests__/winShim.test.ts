import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureCmdShim, ensureCmdShimIfKnown } from "../winShim.js";

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

describe("ensureCmdShimIfKnown", () => {
  describe("on non-win32", () => {
    beforeAll(() => setPlatform("linux"));
    afterAll(() => setPlatform(ORIG_PLATFORM));

    it("returns binary unchanged regardless of name", () => {
      expect(ensureCmdShimIfKnown("npm")).toBe("npm");
      expect(ensureCmdShimIfKnown("git")).toBe("git");
      expect(ensureCmdShimIfKnown("totally-unknown")).toBe("totally-unknown");
    });
  });

  describe("on win32", () => {
    beforeAll(() => setPlatform("win32"));
    afterAll(() => setPlatform(ORIG_PLATFORM));

    it("WRAPS known npm package managers", () => {
      expect(ensureCmdShimIfKnown("npm")).toBe("npm.cmd");
      expect(ensureCmdShimIfKnown("npx")).toBe("npx.cmd");
      expect(ensureCmdShimIfKnown("yarn")).toBe("yarn.cmd");
      expect(ensureCmdShimIfKnown("pnpm")).toBe("pnpm.cmd");
    });

    it("WRAPS known npm-installed dev tools", () => {
      expect(ensureCmdShimIfKnown("tsc")).toBe("tsc.cmd");
      expect(ensureCmdShimIfKnown("eslint")).toBe("eslint.cmd");
      expect(ensureCmdShimIfKnown("biome")).toBe("biome.cmd");
      expect(ensureCmdShimIfKnown("prettier")).toBe("prettier.cmd");
    });

    it("WRAPS Patchwork / Claude orchestration shims", () => {
      expect(ensureCmdShimIfKnown("claude")).toBe("claude.cmd");
      expect(ensureCmdShimIfKnown("claude-ide-bridge")).toBe(
        "claude-ide-bridge.cmd",
      );
      expect(ensureCmdShimIfKnown("gemini")).toBe("gemini.cmd");
      expect(ensureCmdShimIfKnown("code-server")).toBe("code-server.cmd");
    });

    it("WRAPS VS Code-family editor CLIs", () => {
      expect(ensureCmdShimIfKnown("code")).toBe("code.cmd");
      expect(ensureCmdShimIfKnown("cursor")).toBe("cursor.cmd");
      expect(ensureCmdShimIfKnown("windsurf")).toBe("windsurf.cmd");
      expect(ensureCmdShimIfKnown("code-insiders")).toBe("code-insiders.cmd");
    });

    it("LEAVES system binaries alone (PATHEXT resolves .exe)", () => {
      expect(ensureCmdShimIfKnown("git")).toBe("git");
      expect(ensureCmdShimIfKnown("gh")).toBe("gh");
      expect(ensureCmdShimIfKnown("node")).toBe("node");
      expect(ensureCmdShimIfKnown("python")).toBe("python");
      expect(ensureCmdShimIfKnown("echo")).toBe("echo");
    });

    it("LEAVES ambiguously-installed binaries alone", () => {
      expect(ensureCmdShimIfKnown("rg")).toBe("rg");
      expect(ensureCmdShimIfKnown("fd")).toBe("fd");
      expect(ensureCmdShimIfKnown("jq")).toBe("jq");
    });

    it("LEAVES names that already have an extension alone", () => {
      expect(ensureCmdShimIfKnown("npm.cmd")).toBe("npm.cmd");
      expect(ensureCmdShimIfKnown("foo.exe")).toBe("foo.exe");
    });

    it("LEAVES absolute / relative paths alone (even for known shims)", () => {
      expect(ensureCmdShimIfKnown("/usr/local/bin/npm")).toBe(
        "/usr/local/bin/npm",
      );
      expect(ensureCmdShimIfKnown("./bin/npm")).toBe("./bin/npm");
      expect(ensureCmdShimIfKnown("C:\\Tools\\npm")).toBe("C:\\Tools\\npm");
    });
  });
});
