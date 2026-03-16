import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export async function handleCaptureScreenshot(): Promise<unknown> {
  const tmpFile = path.join(os.tmpdir(), `claude-screenshot-${Date.now()}.png`);

  try {
    await new Promise<void>((resolve, reject) => {
      let cmd: string;
      let args: string[];

      if (process.platform === "darwin") {
        cmd = "screencapture";
        args = ["-x", tmpFile]; // -x = silent (no sound)
      } else if (process.platform === "linux") {
        cmd = "import";
        args = ["-window", "root", tmpFile]; // ImageMagick
      } else {
        reject(
          new Error(
            `Screenshot not supported on platform: ${process.platform}`,
          ),
        );
        return;
      }

      const proc = child_process.spawn(cmd, args);
      proc.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Screenshot command exited with code ${code}`));
        }
      });
      proc.on("error", (err) => reject(err));
    });

    const buffer = fs.readFileSync(tmpFile);
    const base64 = buffer.toString("base64");
    return { base64, mimeType: "image/png" };
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // ignore cleanup errors
    }
  }
}
