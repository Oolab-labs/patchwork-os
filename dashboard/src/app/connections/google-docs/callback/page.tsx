import { OAuthCallback } from "@/components/OAuthCallback";

export default function GoogleDocsCallbackPage() {
  return <OAuthCallback provider={{ id: "google-docs", label: "Google Docs" }} />;
}
