import { OAuthCallback } from "@/components/OAuthCallback";

export default function DiscordCallbackPage() {
  return <OAuthCallback provider={{ id: "discord", label: "Discord" }} />;
}
