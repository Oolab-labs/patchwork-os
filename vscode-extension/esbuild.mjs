import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Read the version from the root package.json (bridge + extension share a version)
const rootPkg = require(path.join(__dirname, "../package.json"));
const BRIDGE_VERSION = rootPkg.version;

const watch = process.argv.includes("--watch");

const ctx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  external: ["vscode"],
  platform: "node",
  format: "cjs",
  sourcemap: true,
  minify: !watch,
  define: {
    BRIDGE_VERSION: JSON.stringify(BRIDGE_VERSION),
  },
});

import * as fs from "node:fs";

// Sync shared preset module from bridge (single source of truth at ../src/quickTaskPresets.ts).
// We copy into extension's src/ because rootDir constraints in tsconfig reject cross-tree imports.
const presetSrc = path.join(__dirname, "../src/quickTaskPresets.ts");
const presetDst = path.join(__dirname, "src/quickTaskPresets.ts");
if (fs.existsSync(presetSrc)) {
  const header =
    "// AUTO-GENERATED from ../src/quickTaskPresets.ts — do not edit.\n";
  const body = fs.readFileSync(presetSrc, "utf8");
  fs.writeFileSync(presetDst, header + body);
}

// Copy codicons dist (CSS + TTF font) so the webview can load them via asWebviewUri
const codiconsSrc = path.join(__dirname, "node_modules/@vscode/codicons/dist");
const codiconsDst = path.join(__dirname, "out/codicons");
if (fs.existsSync(codiconsSrc)) {
  fs.mkdirSync(codiconsDst, { recursive: true });
  for (const f of ["codicon.css", "codicon.ttf"]) {
    fs.copyFileSync(path.join(codiconsSrc, f), path.join(codiconsDst, f));
  }
}

if (watch) {
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log("Build complete.");
}
