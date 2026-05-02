import { describe, expect, it } from "vitest";
import { PassphraseError, readPassphraseFromTty } from "../readPassphrase.js";

/**
 * Controllable fake stdin. Holds queued chunks until a `data`
 * listener attaches AND `resume()` is called — matches the real
 * stdin contract that the helper relies on. Tests `push` chunks
 * AFTER kicking off `readPassphraseFromTty`.
 */
class TestStdin {
  private listener: ((chunk: Buffer | string) => void) | null = null;
  private queued: string[] = [];
  private paused = true;

  on(event: "data", fn: (chunk: Buffer | string) => void): void {
    if (event === "data") this.listener = fn;
  }

  off(event: "data", fn: (chunk: Buffer | string) => void): void {
    if (event === "data" && this.listener === fn) this.listener = null;
  }

  setRawMode(): boolean {
    return true;
  }

  resume(): void {
    this.paused = false;
    this.flushQueue();
  }

  pause(): void {
    this.paused = true;
  }

  /** Push a chunk; deliver immediately if a listener is attached and unpaused. */
  push(chunk: string): void {
    this.queued.push(chunk);
    this.flushQueue();
  }

  private flushQueue(): void {
    while (this.queued.length > 0 && !this.paused && this.listener) {
      const chunk = this.queued.shift();
      if (chunk !== undefined) this.listener(chunk);
    }
  }
}

function setup(): {
  stdin: TestStdin;
  promise: Promise<string>;
} {
  const stdin = new TestStdin();
  const promise = readPassphraseFromTty(
    "P: ",
    "Confirm: ",
    // biome-ignore lint/suspicious/noExplicitAny: test-only seam
    stdin as any,
  );
  return { stdin, promise };
}

describe("readPassphraseFromTty", () => {
  it("returns the passphrase when both prompts match", async () => {
    const { stdin, promise } = setup();
    stdin.push("secret\n");
    stdin.push("secret\n");
    expect(await promise).toBe("secret");
  });

  it("rejects when the two passphrases differ", async () => {
    const { stdin, promise } = setup();
    stdin.push("one\n");
    stdin.push("two\n");
    await expect(promise).rejects.toBeInstanceOf(PassphraseError);
  });

  it("rejects an empty passphrase before asking for confirmation", async () => {
    const { stdin, promise } = setup();
    stdin.push("\n");
    await expect(promise).rejects.toThrow(/empty/);
  });

  it("strips backspace + DEL during input (no echo, no leak)", async () => {
    // Step trace for "ab\x08X\x7fcd":
    //   a → "a"; b → "ab"; \x08 (backspace) → "a"; X → "aX";
    //   \x7f (DEL) → "a"; c → "ac"; d → "acd"
    const { stdin, promise } = setup();
    stdin.push("ab\x08X\x7fcd\n");
    stdin.push("ab\x08X\x7fcd\n");
    expect(await promise).toBe("acd");
  });

  it("ignores non-printable control characters (ESC byte) but lets printable bytes through", async () => {
    // ESC (0x1b) + "[A" (printable ASCII tail of arrow-up sequence) + "ok\n"
    const { stdin, promise } = setup();
    stdin.push("\x1b[Aok\n");
    stdin.push("[Aok\n"); // confirmation must equal the resulting buf
    // Known imperfect tradeoff: full ESC-sequence parsing would be a
    // ~50-line state machine; for a passphrase prompt the printable
    // bytes inside an ESC sequence don't meaningfully damage anything
    // (user retypes if confirmation fails). What this test pins is
    // that the literal ESC byte itself is dropped.
    expect(await promise).toBe("[Aok");
  });

  it("aborts on Ctrl-C (0x03)", async () => {
    const { stdin, promise } = setup();
    stdin.push("partial\x03");
    await expect(promise).rejects.toThrow(/cancelled/);
  });

  it("returns single read when confirmPrompt is undefined (decrypt path)", async () => {
    const stdin = new TestStdin();
    const promise = readPassphraseFromTty(
      "P: ",
      undefined,
      // biome-ignore lint/suspicious/noExplicitAny: test-only seam
      stdin as any,
    );
    stdin.push("once\n");
    expect(await promise).toBe("once");
  });
});
