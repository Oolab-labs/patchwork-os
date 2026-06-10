import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Deny list applied to all bridge-spawned subprocess tasks. */
const DENY_LIST = [
  // Publishing / release
  "Bash(npm publish*)",
  "Bash(npm version*)",
  "Bash(yarn publish*)",
  "Bash(pnpm publish*)",
  "Bash(npx semantic-release*)",
  "Bash(npx release-it*)",
  // Git remote / tagging
  "Bash(git push*)",
  "Bash(git tag*)",
  "Bash(gh release*)",
  // Destructive git operations
  "Bash(git reset --hard*)",
  "Bash(git clean -f*)",
  // git clean -d removes untracked directories even without -f in some configs;
  // --force is the long form of -f (drivers-orch-5).
  "Bash(git clean -d*)",
  "Bash(git clean --force*)",
  // Filesystem destruction. Claude Code matches the literal argument string,
  // so reversed-flag and missing-flag variants are distinct patterns that must
  // each be listed (drivers-orch-5).
  "Bash(rm -rf *)",
  "Bash(rm -rf/*)",
  "Bash(rm -fr *)",
  "Bash(rm -r *)",
  "Bash(rm --recursive*)",
  // Privilege escalation
  "Bash(sudo *)",
  "Bash(chmod 777*)",
  // Arbitrary code execution
  "Bash(eval *)",
  "Bash(curl *|*)",
  "Bash(wget *|*)",
  // Process termination
  "Bash(kill -9 *)",
  "Bash(pkill *)",
];

const SETTINGS_CONTENT = JSON.stringify({
  hooks: {},
  permissions: { deny: DENY_LIST },
});

/**
 * Write a minimal subprocess settings file that suppresses hooks and denies
 * destructive operations. Uses --settings instead of --bare to preserve OAuth
 * auth flows (--bare sets CLAUDE_CODE_SIMPLE=1 which skips OAuth).
 */
export function createSubprocessSettings(log: (msg: string) => void): {
  path: string;
  write: () => void;
} {
  const path = join(
    tmpdir(),
    `claude-ide-bridge-subprocess-settings-${process.pid}.json`,
  );
  const write = () => {
    try {
      writeFileSync(path, SETTINGS_CONTENT, "utf-8");
    } catch (err) {
      log(
        `[SubprocessSettings] WARN: could not write settings file at ${path}: ${err instanceof Error ? err.message : String(err)} — subprocess hooks may fire`,
      );
    }
  };
  return { path, write };
}
