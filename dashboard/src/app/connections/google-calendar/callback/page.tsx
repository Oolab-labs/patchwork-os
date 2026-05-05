import { OAuthCallback } from "@/components/OAuthCallback";

export default function CalendarCallbackPage() {
  return (
    <OAuthCallback
      provider={{ id: "google-calendar", label: "Google Calendar" }}
    />
  );
}
