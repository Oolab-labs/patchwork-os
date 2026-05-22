import { OAuthCallback } from "@/components/OAuthCallback";

export default function GithubCallbackPage() {
  return <OAuthCallback provider={{ id: "github", label: "GitHub" }} />;
}
