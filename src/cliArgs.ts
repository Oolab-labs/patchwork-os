/**
 * Refuse an argument the command cannot honour.
 *
 * Three instances of one family were found by hand, each of which reported
 * SUCCESS while doing something other than what was asked: `patchwork evidence
 * verify` running the plain coverage report, `audit-private-identifiers.mjs
 * --message-file` scanning the branch name instead of the commit message, and
 * a scripted `string.replace` that matched nothing. The common property is that
 * the failure is invisible — a silently-ignored argument is indistinguishable
 * from an honoured one, and the command's own success message is what makes the
 * wrong answer convincing.
 *
 * So an unrecognised argument exits non-zero and names what it did not
 * understand. Both halves matter: the exit code is what a script or git hook
 * can act on, and the name is what stops the operator re-running the same typo.
 *
 * ## Why this is not shared with `scripts/audit-*.mjs`
 *
 * Those gates run from `.husky/` hooks, BEFORE any build, so they cannot import
 * from `dist/`, and they are plain `.mjs` outside the TypeScript project. The
 * private-identifier gate therefore carries its own small copy of this rule.
 * That is a real duplication and is recorded rather than hidden: the shared
 * alternative would make a pre-commit hook depend on a build artefact that may
 * not exist, which is a worse failure than two short functions agreeing by
 * review. The echo rule below is the part that must stay in step, and both
 * sides have tests asserting a path-shaped argument is not echoed.
 */

/**
 * Usage errors exit 2, distinct from 1.
 *
 * `evidence verify` exits 1 for a BROKEN CHAIN — the one form of that verb
 * which gates. Collapsing "I did not understand you" into the same code would
 * make a typo indistinguishable from a real integrity failure, in exactly the
 * cron job written to act on one.
 */
export const UNRECOGNISED_EXIT = 2;

/**
 * Is this token safe to print back?
 *
 * A refusal reaches a terminal, scrollback and CI logs. This repository is
 * world-readable and the operator paths typed at it are not, so an arbitrary
 * token is not echoed: a bare word or a flag is, and anything carrying a path
 * separator, an `@`, whitespace or unusual length is described instead. Same
 * line the private-identifier gate holds when it prints an entry NUMBER and
 * never the matched string.
 */
function safeToEcho(token: string): boolean {
  return /^-{0,2}[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(token);
}

function describe(token: string): string {
  return safeToEcho(token)
    ? `'${token}'`
    : "an argument that is not shown, because it may contain a private path";
}

export interface RejectUnknownArgsOpts {
  /** The command being parsed, for the message (e.g. "evidence"). */
  command: string;
  /** Arguments after the command, i.e. `process.argv.slice(3)`. */
  args: string[];
  /** Value-less flags this command accepts. `--help`/`-h` are always allowed. */
  flags: string[];
  /** Flags that consume the following token as their value. */
  valueFlags?: string[];
  /** Subcommands accepted in first position. */
  subcommands?: string[];
  /**
   * Exit the process on a rejection (the default). Pass false to get the
   * message back instead — used by tests, which must be able to assert on the
   * text without terminating the runner.
   */
  exit?: boolean;
}

/**
 * Returns null when every argument is recognised. Otherwise prints to stderr
 * and exits {@link UNRECOGNISED_EXIT}, or — with `exit: false` — returns the
 * message it would have printed.
 */
export function rejectUnknownArgs(
  opts: RejectUnknownArgsOpts,
): { message: string } | null {
  const {
    command,
    args,
    flags,
    valueFlags = [],
    subcommands = [],
    exit = true,
  } = opts;

  const known = new Set([...flags, ...valueFlags, "--help", "-h"]);
  const unknown: string[] = [];

  for (let i = 0; i < args.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: index is bounded by length
    const tok = args[i]!;

    // A subcommand is only a subcommand in first position. Accepting one
    // anywhere would let `evidence --json verify` read as a verify, which is
    // the silent-honour failure this function exists to prevent.
    if (i === 0 && !tok.startsWith("-")) {
      if (subcommands.includes(tok)) continue;
      unknown.push(tok);
      continue;
    }

    if (valueFlags.includes(tok)) {
      i++; // its value is whatever follows, and is not ours to judge
      continue;
    }
    if (known.has(tok)) continue;
    unknown.push(tok);
  }

  if (unknown.length === 0) return null;

  const named = unknown.map(describe).join(", ");
  const accepted = [...subcommands, ...valueFlags, ...flags];
  const message =
    `patchwork ${command}: unrecognised ${unknown.length === 1 ? "argument" : "arguments"}: ${named}\n` +
    // Naming what IS accepted turns the refusal into the answer. Without it the
    // operator's next move is to guess again.
    (accepted.length > 0 ? `  accepted: ${accepted.join(" ")}\n` : "") +
    `  Nothing was run. Try: patchwork ${command} --help\n`;

  if (!exit) return { message };
  process.stderr.write(message);
  process.exit(UNRECOGNISED_EXIT);
}
