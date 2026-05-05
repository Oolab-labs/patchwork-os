import { OAuthCallback } from "@/components/OAuthCallback";

export default function DriveCallbackPage() {
  return (
    <OAuthCallback provider={{ id: "google-drive", label: "Google Drive" }} />
  );
}
