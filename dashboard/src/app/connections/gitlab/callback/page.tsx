import { OAuthCallback } from "@/components/OAuthCallback";

export default function GitLabCallbackPage() {
  return <OAuthCallback provider={{ id: "gitlab", label: "GitLab" }} />;
}
