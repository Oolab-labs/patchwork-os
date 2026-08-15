import { notFound } from "next/navigation";
import { OAuthCallback } from "@/components/OAuthCallback";
import { CONNECTOR_LABELS } from "@/lib/connectorLabels";

/**
 * OAuth callback landing page, for every connector.
 *
 * Replaces 13 directories that each held one four-line file differing only in
 * two string literals. `api/connections/[connector]/` already established the
 * dynamic-segment pattern on the sibling API side; this brings the pages in
 * line with it.
 *
 * Next is configured `output: 'standalone'`, not `export`, so a dynamic
 * segment needs no `generateStaticParams` — checked before writing this,
 * because under static export the missing params would fail the build rather
 * than degrade at runtime.
 *
 * An unknown slug renders `notFound()` rather than a callback UI for a
 * connector that does not exist. That matters here more than on a normal
 * page: this route is where an OAuth provider lands a browser carrying a
 * `code`, and silently accepting an unrecognised slug would present a
 * plausible "connecting…" screen for a flow that can never complete.
 */
export default async function ConnectorCallbackPage({
  params,
}: {
  params: Promise<{ connector: string }>;
}) {
  const { connector } = await params;
  const label = CONNECTOR_LABELS[connector];
  if (!label) notFound();
  return <OAuthCallback provider={{ id: connector, label }} />;
}
