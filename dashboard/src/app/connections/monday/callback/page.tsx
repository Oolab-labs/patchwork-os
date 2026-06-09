import { OAuthCallback } from "@/components/OAuthCallback";

export default function MondayCallbackPage() {
  return <OAuthCallback provider={{ id: "monday", label: "Monday" }} />;
}
