"use client";
import { useEffect, useRef, useState } from "react";
import { apiPath } from "@/lib/api";
import {
  subscribeStreamLiveness,
  subscribeStreamMessage,
} from "@/lib/streamLiveness";

const RECONNECT_DELAY_MS = 3_000;

/** The shared lifecycle stream. Subscriptions to this path are
 *  multiplexed through the `streamLiveness` singleton so a tab opens
 *  exactly one EventSource for it regardless of how many components
 *  consume it. Any other path falls back to a direct EventSource. */
const SHARED_STREAM_PATH = "/api/bridge/stream";

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

		// Shared lifecycle stream: ride the singleton instead of opening
		// a second socket. `subscribeStreamMessage` derives the event
		// type from the payload's `kind` field (e.g. "lifecycle",
		// "tool"), which is what stream consumers actually want to
		// switch on — the legacy direct path forwarded the SSE frame's
		// `.type` ("message" for the bridge's unnamed frames), which
		// silently broke every consumer that guarded on `type`.
		if (path === SHARED_STREAM_PATH) {
			const unsubMsg = subscribeStreamMessage((type, data) => {
				onEventRef.current(type, data);
			});
			const unsubLive = subscribeStreamLiveness((live) => {
				setConnected(live);
				setError(live ? undefined : "Disconnected — reconnecting…");
			});
			return () => {
				unsubMsg();
				unsubLive();
			};
		}

		// Fallback: any other endpoint gets its own EventSource.
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
