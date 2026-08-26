/**
 * Suppress terminal echo while a secret is typed.
 *
 * Node's readline cannot turn echo off portably, so the standard trick is to
 * replace the output stream's `write` with a no-op for the duration of the
 * prompt. The trick has a trap, and `members set-password` fell in it:
 *
 * `readline.createInterface({ input: process.stdin, output: process.stdout })`
 * stores `process.stdout` AS `rl.output`. They are the same object. So muting
 * via `rl.output.write = () => {}` overwrites `process.stdout.write` itself,
 * and unmuting by reading `process.stdout.write` back reads the no-op that was
 * just installed — rebinding the mute permanently. Everything written to
 * stdout after the first prompt vanished, including the "Confirm:" prompt, so
 * the operator typed their confirmation into a prompt they could not see and
 * got "passwords did not match". The error was visible only because it goes to
 * stderr, which was never muted.
 *
 * Capturing the original once, up front, is the whole fix. Returning a
 * restore function rather than a `mute(boolean)` toggle makes the trap hard to
 * reintroduce: there is no path that reads the current value back.
 */

/** The minimal shape this needs — anything with a `write`. */
export interface EchoTarget {
  write: (chunk: string) => boolean | void;
}

/**
 * Silence `target.write` and return the function that restores it.
 *
 * The original is captured BEFORE the no-op is installed, so restoring is
 * always correct no matter how many times this is called or how the target
 * aliases another stream. Restoring twice is harmless.
 */
export function muteEcho(target: EchoTarget): () => void {
  const original = target.write;
  target.write = () => true;
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    target.write = original;
  };
}
