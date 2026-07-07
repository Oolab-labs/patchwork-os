/**
 * Short, human display label for a recipe trigger type.
 *
 * recipes/page.tsx (the Gallery redesign, PR #1080) has trigger *tone*
 * mapping (`triggerTone`, for chip color) but renders the trigger text
 * itself raw (`{r.trigger ?? "manual"}`) — there was no existing short
 * display-name mapper to extract. The Terminal deck's fleet pane used to
 * raw-truncate the trigger string with `.slice(0, 8)` (e.g.
 * "on_test_run" -> "on_test_"), which is what this replaces.
 */
const TRIGGER_LABELS: Record<string, string> = {
  cron: "cron",
  schedule: "cron",
  scheduled: "cron",
  webhook: "webhook",
  http: "webhook",
  file_watch: "save",
  on_file_save: "save",
  fs_watch: "save",
  git_hook: "git",
  git: "git",
  on_test_run: "test",
  test_run: "test",
  channel: "event",
  event: "event",
  bus: "event",
  manual: "manual",
};

export function triggerLabel(trigger: string | undefined | null): string {
  const t = (trigger ?? "manual").toLowerCase();
  return TRIGGER_LABELS[t] ?? t.slice(0, 8);
}

/**
 * Full plain-English phrase for a trigger type, used by the recipes-page
 * filter-chip buttons (as opposed to `triggerLabel`'s short chip text used
 * elsewhere). Falls back to a title-cased version of the raw string for
 * unrecognized trigger types.
 */
const TRIGGER_FILTER_LABELS: Record<string, string> = {
  cron: "On a schedule",
  schedule: "On a schedule",
  scheduled: "On a schedule",
  webhook: "When triggered by a webhook",
  http: "When triggered by a webhook",
  file_watch: "When a file is saved",
  on_file_save: "When a file is saved",
  fs_watch: "When a file is saved",
  git_hook: "When you commit",
  git: "When you commit",
  on_test_run: "When tests run",
  test_run: "When tests run",
  channel: "When an event happens",
  event: "When an event happens",
  bus: "When an event happens",
  manual: "Run manually",
};

export function triggerFilterLabel(trigger: string | undefined | null): string {
  const t = (trigger ?? "manual").toLowerCase();
  if (TRIGGER_FILTER_LABELS[t]) return TRIGGER_FILTER_LABELS[t];
  return t.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
