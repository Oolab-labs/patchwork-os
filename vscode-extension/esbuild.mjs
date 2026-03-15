import * as esbuild from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

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

if (watch) {
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log("Build complete.");
}
