import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const rg = "node_modules/.bin/rg";
console.log("symlink exists:", existsSync(rg));
try {
  const v = execFileSync(rg, ["--version"], { encoding: "utf8" }).trim();
  console.log("rg version:", v.split("\n")[0]);
} catch (e) {
  console.error("rg exec failed:", e.message);
}
