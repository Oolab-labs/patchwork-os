"use client";
import { useEffect, useRef, useState } from "react";

export interface UseBridgeFetchResult<T> {
  data: T | null;
  error: string | undefined;
  loading: boolean;
  status: number | null;
  unsupported: boolean;
}

export function useBridgeFetch<T>(
  path: string,
  options?: {
    intervalMs?: number;
    transform?: (data: unknown) => T;
    unsupportedValue?: T | null;
    enabled?: boolean;
  },
): UseBridgeFetchResult<T> {
  const intervalMs = options?.intervalMs ?? 5000;
  const enabled = options?.enabled ?? true;
  const unsupportedValue = options?.unsupportedValue ?? null;
  const transformRef = useRef(options?.transform);
  transformRef.current = options?.transform;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<number | null>(null);
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    if (!enabled) return;

    let alive = true;

    const tick = async () => {
      try {
        const res = await fetch(path);
        if (!alive) return;
        setStatus(res.status);

        if (res.status === 404) {
          setUnsupported(true);
          setData(unsupportedValue as T | null);
          setError(undefined);
          setLoading(false);
          return;
        }

        if (res.status === 503) {
          setError("Bridge not running");
          setLoading(false);
          return;
        }

        if (!res.ok) {
          setError(`Request failed: ${res.status}`);
          setLoading(false);
          return;
        }

        const raw: unknown = await res.json();
        if (!alive) return;
        const result = transformRef.current
          ? transformRef.current(raw)
          : (raw as T);
        setData(result);
        setUnsupported(false);
        setError(undefined);
        setLoading(false);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    };

    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [path, intervalMs, enabled, unsupportedValue]);

  return { data, error, loading, status, unsupported };
}
