import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rgBin = path.join(__dirname, "..", "node_modules", ".bin", "rg");
const workspace = path.join(__dirname, "..");

try {
  const out = execFileSync(rgBin, ["-l", "ExtensionTimeoutError", workspace], {
    encoding: "utf8",
    timeout: 5000,
  });
  console.log("rg works, found files:\n", out.slice(0, 200));
} catch (e) {
  console.error("rg failed:", e.message);
  console.error("stderr:", e.stderr?.slice(0, 200));
}
