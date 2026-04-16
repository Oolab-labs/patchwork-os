"use client";
import React, { useEffect, useState } from "react";

interface Pending {
	callId: string;
	toolName: string;
	tier: "low" | "medium" | "high";
	requestedAt: number;
	summary?: string;
}

interface CcRules {
	allow: string[];
	ask: string[];
	deny: string[];
	workspace: string;
}

const BRIDGE_PORT = process.env.NEXT_PUBLIC_BRIDGE_PORT ?? "41291";
const API = `http://127.0.0.1:${BRIDGE_PORT}`;

export default function ApprovalsPage() {
	const [pending, setPending] = useState<Pending[]>([]);
	const [rules, setRules] = useState<CcRules | null>(null);
	const [err, setErr] = useState<string>();

	useEffect(() => {
		const tick = async () => {
			try {
				const [pRes, rRes] = await Promise.all([
					fetch(`${API}/approvals`),
					fetch(`${API}/cc-permissions`),
				]);
				if (!pRes.ok) throw new Error(`/approvals ${pRes.status}`);
				setPending((await pRes.json()) as Pending[]);
				if (rRes.ok) setRules((await rRes.json()) as CcRules);
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
				{pending.map((p) => {
					const match = matchRule(p.toolName, rules);
					return (
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
								{match && <span style={badge(match)}>CC: {match}</span>}
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
					);
				})}
			</ul>

			{rules && (
				<details style={{ marginTop: 24, opacity: 0.75 }}>
					<summary>CC permission rules ({rules.workspace})</summary>
					<RulesSummary rules={rules} />
				</details>
			)}
		</section>
	);
}

function RulesSummary({ rules }: { rules: CcRules }) {
	return (
		<div style={{ fontSize: 12, marginTop: 8 }}>
			<Row
				label="deny"
				count={rules.deny.length}
				tone="#f87171"
				items={rules.deny}
			/>
			<Row
				label="ask"
				count={rules.ask.length}
				tone="#fbbf24"
				items={rules.ask}
			/>
			<Row
				label="allow"
				count={rules.allow.length}
				tone="#34d399"
				items={rules.allow}
			/>
		</div>
	);
}

function Row({
	label,
	count,
	tone,
	items,
}: {
	label: string;
	count: number;
	tone: string;
	items: string[];
}) {
	return (
		<div style={{ marginBottom: 4 }}>
			<strong style={{ color: tone }}>
				{label} ({count})
			</strong>
			{items.length > 0 && (
				<span style={{ opacity: 0.7 }}>
					: {items.slice(0, 5).join(", ")}
					{items.length > 5 ? "…" : ""}
				</span>
			)}
		</div>
	);
}

function matchRule(
	toolName: string,
	rules: CcRules | null,
): "deny" | "ask" | "allow" | null {
	if (!rules) return null;
	const match = (list: string[]) =>
		list.some((r) => r === toolName || r.startsWith(`${toolName}(`));
	if (match(rules.deny)) return "deny";
	if (match(rules.ask)) return "ask";
	if (match(rules.allow)) return "allow";
	return null;
}

function badge(kind: "deny" | "ask" | "allow"): React.CSSProperties {
	const bg =
		kind === "deny" ? "#4c1d1d" : kind === "ask" ? "#4c3a1d" : "#1d4c2d";
	const fg =
		kind === "deny" ? "#fca5a5" : kind === "ask" ? "#fcd34d" : "#86efac";
	return {
		background: bg,
		color: fg,
		fontSize: 11,
		padding: "2px 6px",
		borderRadius: 4,
	};
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
