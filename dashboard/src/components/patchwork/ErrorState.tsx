import type { ReactNode } from "react";

export function ErrorState({
  title = "Something went wrong",
  description,
  error,
  action,
  onRetry,
  retryLabel = "Retry",
}: {
  title?: ReactNode;
  description?: ReactNode;
  /** Raw error — string or Error instance. Rendered as a small monospace detail. */
  error?: string | Error | null;
  action?: ReactNode;
  /** Convenience: renders a default Retry button if provided and `action` is not. */
  onRetry?: () => void;
  retryLabel?: ReactNode;
}) {
  const detail =
    error instanceof Error ? error.message : typeof error === "string" ? error : null;

  return (
    <div className="empty" role="alert">
      <div
        style={{
          marginBottom: 12,
          display: "flex",
          justifyContent: "center",
          color: "var(--err)",
        }}
        aria-hidden="true"
      >
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      </div>
      <h3 style={{ color: "var(--ink-1)", marginBottom: 8 }}>{title}</h3>
      {description && (
        <p style={{ color: "var(--ink-2)", fontSize: 13, maxWidth: 420, margin: "0 auto 12px" }}>
          {description}
        </p>
      )}
      {detail && (
        <pre
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--ink-3)",
            background: "var(--recess)",
            border: "1px solid var(--line-1)",
            borderRadius: 6,
            padding: "8px 10px",
            margin: "0 auto 16px",
            maxWidth: 480,
            overflow: "auto",
            textAlign: "left",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {detail}
        </pre>
      )}
      {(action || onRetry) && (
        <div style={{ display: "flex", justifyContent: "center", gap: 8 }}>
          {action ??
            (onRetry && (
              <button
                type="button"
                onClick={onRetry}
                style={{
                  background: "var(--accent)",
                  color: "var(--on-accent)",
                  border: "none",
                  borderRadius: "var(--r-2)",
                  padding: "6px 14px",
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                {retryLabel}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
