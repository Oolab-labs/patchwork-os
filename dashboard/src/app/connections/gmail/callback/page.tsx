import { OAuthCallback } from "@/components/OAuthCallback";

export default function GmailCallbackPage() {
  return <OAuthCallback provider={{ id: "gmail", label: "Gmail" }} />;
}
