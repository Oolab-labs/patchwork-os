#!/usr/bin/env node
/**
 * Sync shared preset module from bridge (src/quickTaskPresets.ts) into the
 * extension tree so the extension's tsconfig rootDir doesn't reject the
 * cross-tree import. Runs at both build time (esbuild prebuild) and test
 * time (vitest pretest) — both contexts need the file present on disk.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(__dirname, "..", "..", "src", "quickTaskPresets.ts");
const dst = path.resolve(__dirname, "..", "src", "quickTaskPresets.ts");

if (!existsSync(src)) {
  console.error(`[sync-presets] source missing: ${src}`);
  process.exit(1);
}

const header =
  "// AUTO-GENERATED from ../src/quickTaskPresets.ts — do not edit.\n";
writeFileSync(dst, header + readFileSync(src, "utf8"));
console.log(
  `[sync-presets] ${path.relative(process.cwd(), dst)} ← ${path.relative(process.cwd(), src)}`,
);
