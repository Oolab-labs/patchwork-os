"use client";
import { useEffect, useRef, useState } from "react";
import { apiPath } from "@/lib/api";
import { isDemoMode } from "@/lib/demoMode";

const RECONNECT_DELAY_MS = 3_000;

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
		if (isDemoMode()) return;

		let es: EventSource | null = null;
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
		let alive = true;

		function connect() {
			if (!alive) return;
			try {
				es = new EventSource(apiPath(path));
			} catch {
				return;
			}

			es.onopen = () => {
				if (alive) {
					setConnected(true);
					setError(undefined);
				}
			};

			es.onerror = () => {
				if (!alive) return;
				setConnected(false);
				setError("Disconnected — reconnecting…");
				es?.close();
				es = null;
				reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
			};

			es.onmessage = (msg) => {
				if (!alive) return;
				try {
					const data: unknown = JSON.parse(msg.data as string);
					onEventRef.current(msg.type || "message", data);
				} catch {
					// skip unparseable events
				}
			};
		}

		connect();

		return () => {
			alive = false;
			if (reconnectTimer !== null) clearTimeout(reconnectTimer);
			es?.close();
			es = null;
		};
	}, [path, enabled]);

	return { connected, error };
}
