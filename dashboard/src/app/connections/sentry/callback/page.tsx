import { OAuthCallback } from "@/components/OAuthCallback";

export default function SentryCallbackPage() {
  return <OAuthCallback provider={{ id: "sentry", label: "Sentry" }} />;
}
