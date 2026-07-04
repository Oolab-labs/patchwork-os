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
