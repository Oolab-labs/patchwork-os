/**
 * Link to a run's detail page.
 *
 * A run number (`seq`) is only unique per bridge — the bridges sharing one
 * run log hand the same number to different runs — so a link that carries
 * only the number can open a different run. Pass the run's `taskId` whenever
 * the source row has it: the page then loads, replays and plans that exact
 * run. Without it the page falls back to the number and, when the number is
 * shared, offers a choice instead of guessing silently.
 */
export function runHref(
  seq: number | string,
  taskId?: string | null,
  fragment = "",
): string {
  const task = taskId ? `?task=${encodeURIComponent(taskId)}` : "";
  return `/runs/${seq}${task}${fragment}`;
}
