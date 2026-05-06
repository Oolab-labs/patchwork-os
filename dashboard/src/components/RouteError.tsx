"use client";

// Shared error boundary body for per-route error.tsx files. Keeps copy and
// styling consistent across routes without each file re-implementing the
// alert card.
export function RouteError({
  error,
  reset,
  title = "Something went wrong",
}: {
  error: Error;
  reset: () => void;
  title?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "60vh",
        padding: "2rem",
      }}
    >
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--err)",
          borderRadius: "var(--r-m)",
          padding: "2rem",
          maxWidth: 480,
          width: "100%",
        }}
      >
        <h2
          style={{
            color: "var(--err)",
            fontFamily: "var(--font-sans)",
            fontSize: "1.125rem",
            fontWeight: 600,
            margin: "0 0 0.5rem",
          }}
        >
          {title}
        </h2>
        <p
          style={{
            color: "var(--ink-2)",
            fontFamily: "var(--font-sans)",
            fontSize: "0.875rem",
            margin: "0 0 1.25rem",
            wordBreak: "break-word",
          }}
        >
          {error.message}
        </p>
        <button
          type="button"
          onClick={reset}
          style={{
            background: "var(--accent)",
            border: "none",
            borderRadius: "var(--r-s)",
            color: "var(--on-accent)",
            cursor: "pointer",
            fontFamily: "var(--font-sans)",
            fontSize: "0.875rem",
            fontWeight: 500,
            padding: "0.5rem 1rem",
          }}
        >
          Try again
        </button>
      </div>
    </div>
  );
}
