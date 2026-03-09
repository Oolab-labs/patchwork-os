#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Bridge } from "./bridge.js";
import { findEditor, parseConfig } from "./config.js";

// Handle install-extension subcommand before parseConfig (avoids unknown-flag error)
if (process.argv[2] === "install-extension") {
  const editor = process.argv[3] || findEditor();
  if (!editor) {
    process.stderr.write(
      "Error: No editor found. Specify the editor command: claude-ide-bridge install-extension <code|cursor|windsurf>\n",
    );
    process.exit(1);
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const vsixPath = path.resolve(
    __dirname,
    "..",
    "vscode-extension",
    "claude-ide-bridge-extension-0.1.0.vsix",
  );

  try {
    process.stderr.write(`Installing extension via ${editor}...\n`);
    execFileSync(editor, ["--install-extension", vsixPath], {
      stdio: "inherit",
      timeout: 30000,
    });
    process.stderr.write("Extension installed successfully.\n");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error installing extension: ${message}\n`);
    process.exit(1);
  }
  process.exit(0);
}

const config = parseConfig(process.argv);
const bridge = new Bridge(config);

bridge.start().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
});
