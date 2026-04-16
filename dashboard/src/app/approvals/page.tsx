"use client";
import { useEffect, useState } from "react";

interface Pending {
	callId: string;
	toolName: string;
	tier: "low" | "medium" | "high";
	requestedAt: number;
	summary?: string;
}

const BRIDGE_PORT = process.env.NEXT_PUBLIC_BRIDGE_PORT ?? "41291";
const API = `http://127.0.0.1:${BRIDGE_PORT}`;

export default function ApprovalsPage() {
	const [pending, setPending] = useState<Pending[]>([]);
	const [err, setErr] = useState<string>();

	useEffect(() => {
		const tick = async () => {
			try {
				const res = await fetch(`${API}/approvals`);
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				setPending((await res.json()) as Pending[]);
				setErr(undefined);
			} catch (e) {
				setErr(e instanceof Error ? e.message : String(e));
			}
		};
		tick();
		const id = setInterval(tick, 2000);
		return () => clearInterval(id);
	}, []);

	async function decide(callId: string, decision: "approve" | "reject") {
		await fetch(`${API}/${decision}/${callId}`, { method: "POST" });
	}

	return (
		<section>
			<h2>Pending approvals</h2>
			{err && <p style={{ color: "#f87171" }}>Unreachable: {err}</p>}
			{pending.length === 0 && !err && (
				<p style={{ opacity: 0.7 }}>Nothing waiting.</p>
			)}
			<ul style={{ listStyle: "none", padding: 0 }}>
				{pending.map((p) => (
					<li
						key={p.callId}
						style={{
							border: "1px solid #1b2028",
							borderRadius: 8,
							padding: 12,
							marginBottom: 8,
						}}
					>
						<div style={{ display: "flex", gap: 12, alignItems: "center" }}>
							<strong>{p.toolName}</strong>
							<span style={{ color: tierColor(p.tier) }}>{p.tier}</span>
							<small style={{ marginLeft: "auto", opacity: 0.6 }}>
								{new Date(p.requestedAt).toLocaleTimeString()}
							</small>
						</div>
						{p.summary && <p style={{ opacity: 0.8 }}>{p.summary}</p>}
						<div style={{ display: "flex", gap: 8, marginTop: 8 }}>
							<button
								onClick={() => decide(p.callId, "approve")}
								style={btn("#16a34a")}
								type="button"
							>
								Approve
							</button>
							<button
								onClick={() => decide(p.callId, "reject")}
								style={btn("#dc2626")}
								type="button"
							>
								Reject
							</button>
						</div>
					</li>
				))}
			</ul>
		</section>
	);
}

function tierColor(t: string) {
	return t === "high" ? "#f87171" : t === "medium" ? "#fbbf24" : "#34d399";
}
function btn(bg: string): React.CSSProperties {
	return {
		background: bg,
		color: "white",
		border: "none",
		padding: "6px 12px",
		borderRadius: 4,
		cursor: "pointer",
	};
}
