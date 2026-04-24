"use client";
import { useEffect, useRef, useState } from "react";
import { apiPath } from "@/lib/api";

export function useBridgeStream(
  path: string,
  onEvent: (type: string, data: unknown) => void,
  options?: { enabled?: boolean },
): { connected: boolean; error: string | undefined } {
  const enabled = options?.enabled ?? true;
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!enabled) return;

    const es = new EventSource(apiPath(path));

    es.onopen = () => {
      setConnected(true);
      setError(undefined);
    };

    es.onerror = () => {
      setConnected(false);
      setError("Disconnected — reconnecting…");
    };

    es.onmessage = (msg) => {
      try {
        const data: unknown = JSON.parse(msg.data as string);
        onEventRef.current(msg.type || "message", data);
      } catch {
        // skip unparseable events
      }
    };

    return () => es.close();
  }, [path, enabled]);

  return { connected, error };
}
