import type { ConnectorStatus } from "./types";

/**
 * What the connections page says about whether a credential WORKS, as
 * opposed to merely being stored (audit 2026-10-15, H9). Pure, so the page
 * renders what the bridge reported and never infers a state of its own.
 */
export interface VerificationSummary {
  state: "verified" | "failed" | "unverified";
  label: string;
  title: string;
}

function when(iso: string | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : ` ${new Date(t).toLocaleString()}`;
}

export function verificationSummary(
  entry: ConnectorStatus,
): VerificationSummary | null {
  if (entry.status === "disconnected" || !entry.verification) return null;
  switch (entry.verification) {
    case "verified":
      return {
        state: "verified",
        label: "Verified",
        title: entry.lastCheck?.ok
          ? `Test passed${when(entry.lastCheck.at)}`
          : `Proven by an authenticated call${when(entry.verifiedAt)}`,
      };
    case "failed":
      return {
        state: "failed",
        label: "Test failed",
        title: `Last Test failed${when(entry.lastCheck?.at)} — run Test again, or reconnect if it keeps failing`,
      };
    case "unverified":
      return {
        state: "unverified",
        label: "Not verified",
        title:
          "A credential is stored but has not been shown to work — run Test to confirm it",
      };
  }
}

/**
 * Connector ids for the "Recently used" strip: connected connectors with a
 * real successful call, most recent first. Never the connect time — that was
 * how "connected yesterday, never used" ranked as recent activity.
 */
export function recentlyUsedOrder(
  entries: readonly ConnectorStatus[],
  limit = 4,
): string[] {
  return entries
    .filter(
      (e) =>
        e.status === "connected" &&
        typeof e.lastSuccessAt === "string" &&
        !Number.isNaN(Date.parse(e.lastSuccessAt)),
    )
    .sort(
      (a, b) =>
        Date.parse(b.lastSuccessAt as string) -
        Date.parse(a.lastSuccessAt as string),
    )
    .slice(0, limit)
    .map((e) => e.id);
}
