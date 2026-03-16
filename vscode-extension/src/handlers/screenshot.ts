import * as child_process from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 50;

async function readWithRetry(filePath: string): Promise<Buffer> {
  for (let attempt = 0; attempt < RETRY_COUNT; attempt++) {
    try {
      return await fsp.readFile(filePath);
    } catch (err) {
      if (attempt === RETRY_COUNT - 1) throw err;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  // unreachable — for type safety
  return fsp.readFile(filePath);
}

export async function handleCaptureScreenshot(): Promise<unknown> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpFile = path.join(os.tmpdir(), `claude-screenshot-${suffix}.png`);

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

    const buffer = await readWithRetry(tmpFile);
    const base64 = buffer.toString("base64");
    return { base64, mimeType: "image/png" };
  } finally {
    try {
      await fsp.unlink(tmpFile);
    } catch {
      // ignore cleanup errors
    }
  }
}
