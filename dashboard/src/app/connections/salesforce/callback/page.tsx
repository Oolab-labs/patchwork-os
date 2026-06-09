import { OAuthCallback } from "@/components/OAuthCallback";

export default function SalesforceCallbackPage() {
  return <OAuthCallback provider={{ id: "salesforce", label: "Salesforce" }} />;
}
