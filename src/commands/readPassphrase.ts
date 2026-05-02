/**
 * readPassphraseFromTty — no-echo TTY passphrase prompt with confirmation.
 *
 * Used by `patchwork traces export --encrypt` when no
 * `PATCHWORK_TRACES_PASSPHRASE` env var is set and the process is
 * attached to a TTY. The non-TTY path is rejected by the caller — there
 * is no scenario where silently reading from a redirected stdin would
 * be the right choice for a passphrase.
 *
 * Why this isn't using `readline.question`: readline echoes by default
 * and toggling echo off after the prompt is fired races against the
 * user typing. We use raw mode + manual character read so the first
 * keystroke is already silent.
 */

import { Readable } from "node:stream";

export class PassphraseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PassphraseError";
  }
}

interface ReadlineLite {
  on(event: "data", fn: (chunk: Buffer | string) => void): void;
  off(event: "data", fn: (chunk: Buffer | string) => void): void;
  setRawMode?(mode: boolean): boolean;
  resume(): unknown;
  pause(): unknown;
}

async function readLineSilent(stdin: ReadlineLite): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunkRaw: Buffer | string) => {
      const chunk =
        typeof chunkRaw === "string" ? chunkRaw : chunkRaw.toString("utf8");
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        // Ctrl-C (0x03) — abort.
        if (code === 0x03) {
          stdin.off("data", onData);
          stdin.setRawMode?.(false);
          stdin.pause();
          reject(new PassphraseError("passphrase prompt cancelled"));
          return;
        }
        // CR (0x0d) or LF (0x0a) — line terminator.
        if (code === 0x0d || code === 0x0a) {
          stdin.off("data", onData);
          stdin.setRawMode?.(false);
          stdin.pause();
          process.stdout.write("\n");
          resolve(buf);
          return;
        }
        // Backspace (0x08) or DEL (0x7f) — strip last char.
        if (code === 0x08 || code === 0x7f) {
          buf = buf.slice(0, -1);
          continue;
        }
        // Any other control char (0x00–0x1f, except tab 0x09) — ignore
        // (no echo of arrow keys, ESC sequences, etc.).
        if (code < 0x20 && code !== 0x09) continue;
        buf += ch;
      }
    };
    stdin.on("data", onData);
    stdin.setRawMode?.(true);
    stdin.resume();
  });
}

/**
 * Prompt for a passphrase on the controlling TTY, twice, with no echo.
 * Returns the matching passphrase. Throws `PassphraseError` if the two
 * entries don't match, the user hits Ctrl-C, or the passphrase is empty.
 *
 * `confirmPrompt` may be undefined for callers (tests, decrypt flows)
 * that only want one read.
 */
export async function readPassphraseFromTty(
  prompt: string,
  /**
   * If a non-empty string, prompt twice and require both entries to
   * match. If `undefined` (the decrypt path) prompt once. JS default-
   * parameter semantics mean we cannot give this a default — callers
   * passing `undefined` would trigger the default and get an
   * accidental confirmation prompt.
   */
  confirmPrompt: string | undefined,
  /** Test seam — defaults to process.stdin. */
  stdin: ReadlineLite = process.stdin as unknown as ReadlineLite,
): Promise<string> {
  process.stdout.write(prompt);
  const first = await readLineSilent(stdin);
  if (first.length === 0) {
    throw new PassphraseError("empty passphrase rejected");
  }
  if (confirmPrompt === undefined) return first;
  process.stdout.write(confirmPrompt);
  const second = await readLineSilent(stdin);
  if (first !== second) {
    throw new PassphraseError("passphrases did not match");
  }
  return first;
}

/**
 * Construct a fake stdin from a sequence of strings — used by tests so
 * the no-echo path can be exercised without an actual TTY. The
 * resulting object has the minimal `on/off/setRawMode/resume/pause`
 * shape `readLineSilent` consumes.
 */
export function makeFakeStdin(input: string): ReadlineLite {
  const stream = Readable.from([input]);
  return {
    on: (event, fn) => stream.on(event, fn),
    off: (event, fn) => stream.off(event, fn),
    setRawMode: () => true,
    resume: () => stream.resume(),
    pause: () => stream.pause(),
  };
}
