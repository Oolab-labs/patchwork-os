import type { ReactNode } from "react";

export type StatusTone =
  | "ok"
  | "warn"
  | "err"
  | "info"
  | "accent"
  | "muted"
  | "purple";

const TONE_CLASS: Record<StatusTone, string> = {
  ok: "chip-green",
  warn: "chip-amber",
  err: "chip-red",
  info: "chip-blue",
  accent: "chip-accent",
  muted: "chip-muted",
  purple: "chip-purple",
};

export function StatusPill({
  tone = "muted",
  dot = false,
  children,
  className,
  title,
}: {
  tone?: StatusTone;
  dot?: boolean;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  const cls = `chip ${TONE_CLASS[tone]}${className ? ` ${className}` : ""}`;
  return (
    <span className={cls} title={title}>
      {dot && <span className="dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

/**
 * Honest run-status derivation. A run that finished `status: "done"` while
 * one or more steps errored is NOT a clean success — the bridge run log
 * carries `hadStepErrors` (see runLog.ts) for exactly this case. Surface it
 * as an amber "completed with errors" state instead of a green "done".
 *
 * Returns the chip tone + display label so the runs list cell and the
 * run-detail header render the same verdict from one place.
 */
export function deriveRunStatus(
  status: string,
  opts?: { hadStepErrors?: boolean; assertionFailures?: number },
): { tone: StatusTone; label: string } {
  const assertionFails = opts?.assertionFailures ?? 0;
  if (status === "running") return { tone: "info", label: "running" };
  if (assertionFails > 0) {
    return { tone: "err", label: `error · ${assertionFails} fail` };
  }
  if (status === "done" && opts?.hadStepErrors) {
    return { tone: "warn", label: "completed with errors" };
  }
  if (status === "done") return { tone: "ok", label: "done" };
  if (status === "error") return { tone: "err", label: "error" };
  return { tone: "warn", label: status };
}
