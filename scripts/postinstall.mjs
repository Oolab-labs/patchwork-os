#!/usr/bin/env node
/**
 * postinstall.mjs — wire up optional local binaries into node_modules/.bin
 * so that probeAll() can discover them via the standard local-bin lookup.
 *
 * Currently handles:
 *   @vscode/ripgrep  →  node_modules/.bin/rg
 */

import { existsSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const binDir = path.join(root, "node_modules", ".bin");
const require = createRequire(import.meta.url);

function linkBin(pkgName, binaryName, linkName = binaryName) {
  try {
    const pkg = require(`${pkgName}/package.json`);
    // Try common binary locations
    const candidates = [
      path.join(root, "node_modules", pkgName, "bin", binaryName),
      path.join(root, "node_modules", pkgName, binaryName),
    ];
    // Also check the package's bin field
    if (pkg.bin) {
      const binEntry =
        typeof pkg.bin === "string" ? pkg.bin : pkg.bin[binaryName];
      if (binEntry) {
        candidates.unshift(path.join(root, "node_modules", pkgName, binEntry));
      }
    }
    const src = candidates.find(existsSync);
    if (!src) {
      console.log(`  skip ${linkName}: ${pkgName} binary not found`);
      return;
    }
    mkdirSync(binDir, { recursive: true });
    const dest = path.join(binDir, linkName);
    if (existsSync(dest)) {
      unlinkSync(dest);
    }
    symlinkSync(src, dest);
    console.log(`  linked ${linkName} → ${path.relative(root, src)}`);
  } catch {
    // Package not installed — silently skip
  }
}

console.log("[postinstall] Linking optional local binaries...");
linkBin("@vscode/ripgrep", "rg");
console.log("[postinstall] Done.");
