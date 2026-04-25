"use client";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
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
          maxWidth: "480px",
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
          Something went wrong
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
          onClick={reset}
          style={{
            background: "var(--accent)",
            border: "none",
            borderRadius: "var(--r-s)",
            color: "#fff",
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
