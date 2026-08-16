import { memberLoginConfigured } from "@/lib/memberAuth";
import { LoginForm } from "./login-form";

interface PageProps {
  searchParams?: Promise<{ next?: string | string[] }>;
}

/**
 * Read per request, never prerendered. `memberLoginConfigured()` reads
 * `~/.patchwork/credentials.json`, so a statically rendered login page would
 * bake in whether member login existed at BUILD time — and the operator adding
 * their first member would see no field until the next deploy.
 */
export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: PageProps) {
  const sp = (await searchParams) ?? {};
  const rawNext = sp.next;
  const next = Array.isArray(rawNext) ? rawNext[0] : rawNext;
  // Same-origin guard mirrors /api/login isSafeRedirect — we only honor
  // a `next` that's a relative path, never a protocol-relative or
  // off-host URL.
  const safeNext =
    typeof next === "string" &&
    next.startsWith("/") &&
    !next.startsWith("//") &&
    !next.startsWith("/\\")
      ? next
      : "/dashboard";

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        padding: 24,
        background: "var(--bg-0)",
        color: "var(--ink-0)",
        fontFamily: "var(--font-sans)",
      }}
    >
      <div style={{ width: "100%", maxWidth: 360 }}>
        <h1
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-xl)",
            margin: "0 0 8px",
            fontWeight: 700,
          }}
        >
          patchwork
        </h1>
        <p style={{ margin: "0 0 24px", fontSize: "var(--fs-m)", color: "var(--ink-2)" }}>
          {memberLoginConfigured()
            ? "Sign in as yourself, or with the shared dashboard password."
            : "Enter the dashboard password to continue."}
        </p>
        <LoginForm next={safeNext} members={memberLoginConfigured()} />
      </div>
    </main>
  );
}
