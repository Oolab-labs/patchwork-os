"use client";
import { RouteError } from "@/components/RouteError";

export default function ErrorBoundary({ error, reset }: { error: Error; reset: () => void }) {
  return <RouteError error={error} reset={reset} />;
}
