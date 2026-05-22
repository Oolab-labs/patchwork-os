import { OAuthCallback } from "@/components/OAuthCallback";

export default function LinearCallbackPage() {
  return <OAuthCallback provider={{ id: "linear", label: "Linear" }} />;
}
