import { readdirSync } from "node:fs";

/**
 * Boot-time scan for legacy `<name>.permissions.json` sidecars left over from
 * pre-alpha.36 installs. The sidecar files were decorative — never read by
 * toolRegistry — so they're safe to ignore on disk. Emits a single warning
 * pointing users at the canonical permission location (~/.claude/settings.json).
 *
 * Per recipe-dogfood-2026-05-01/PLAN-MASTER-V2.md A-PR4 §6 (R2 L-2):
 * - Fires ONCE per boot, not per recipe.
 * - Skipped under NODE_ENV=test so vitest output stays clean.
 * - Migration script for users who want to archive:
 *     find ~/.patchwork/recipes -name '*.permissions.json' \
 *       -exec mv {} ~/.patchwork/recipes/.permissions-archive/ \;
 */

const DOC_URL =
  "https://github.com/Oolab-labs/patchwork-os/blob/main/docs/dogfood/recipe-dogfood-2026-05-01/PLAN-MASTER-V2.md";

export interface PermissionsSidecarWarningResult {
  count: number;
  warned: boolean;
}

/**
 * Scans `recipesDir` for legacy permissions sidecar files. Emits a single
 * `console.warn` if any are found (skipped in test env). Returns the count
 * for caller observability + tests.
 */
export function warnAboutLegacyPermissionsSidecars(
  recipesDir: string,
  options: { warn?: (msg: string) => void } = {},
): PermissionsSidecarWarningResult {
  let entries: string[];
  try {
    entries = readdirSync(recipesDir);
  } catch {
    return { count: 0, warned: false };
  }

  const sidecars = entries.filter((f) => f.endsWith(".permissions.json"));
  const count = sidecars.length;

  if (count === 0) {
    return { count: 0, warned: false };
  }

  if (process.env.NODE_ENV === "test" && !options.warn) {
    return { count, warned: false };
  }

  const warn = options.warn ?? ((msg: string) => console.warn(msg));
  warn(
    `[patchwork] Found ${count} legacy <name>.permissions.json sidecar file${
      count === 1 ? "" : "s"
    } in ${recipesDir}. ` +
      `These are decorative and no longer generated (alpha.36+). ` +
      `Configure tool gating in ~/.claude/settings.json. ` +
      `Migration guide: ${DOC_URL}`,
  );
  return { count, warned: true };
}
