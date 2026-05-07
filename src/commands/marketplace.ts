/**
 * `patchwork marketplace` — DEPRECATED.
 *
 * This subcommand previously fetched a hand-curated registry of "skills" and
 * shelled out to `npm install -g <skill-package>`. As of 0.2.0-beta.0 the
 * registry contained only built-in skills that already ship inside the bridge,
 * pointed at a stale npm package name (`claude-ide-bridge`, not
 * `patchwork-os`), and had zero third-party authors. See issue #279 for the
 * decision rationale.
 *
 * The stub is preserved (rather than removed wholesale) so anyone with tooling
 * that calls `patchwork marketplace …` gets a clear migration message instead
 * of a "unknown subcommand" error. It will be removed in a future major
 * release.
 */

const DEPRECATION_MESSAGE = `The 'marketplace' command is deprecated and no longer maintained.

Built-in skills (tdd-loop, ide-coverage, ide-diagnostics-board, ide-explore,
ide-deps) ship inside the bridge package — no installation needed.

For community content, use the recipe-bundle install path instead:
  patchwork recipe install github:<org>/<repo>

To discover plugins on npm:
  npm search keywords:claude-ide-bridge-plugin

This subcommand will be removed in a future major release. See issue #279.`;

export async function runMarketplace(argv: string[]): Promise<void> {
  void argv; // intentionally ignored — every subcommand prints the same notice
  console.log(DEPRECATION_MESSAGE);
}
