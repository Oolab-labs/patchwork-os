import { OAuthCallback } from "@/components/OAuthCallback";

export default function SlackCallbackPage() {
  return <OAuthCallback provider={{ id: "slack", label: "Slack" }} />;
}
