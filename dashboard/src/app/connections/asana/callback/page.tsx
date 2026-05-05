import { OAuthCallback } from "@/components/OAuthCallback";

export default function AsanaCallbackPage() {
  return <OAuthCallback provider={{ id: "asana", label: "Asana" }} />;
}
