"use client";
import Link from "next/link";
import { StatusPill } from "@/components/patchwork";
import type { ActiveRunState } from "@/hooks/useRecipeRunStream";

function pct(state: ActiveRunState): number {
	if (state.totalSteps <= 0) return 0;
	return Math.min(100, Math.round((state.doneSteps / state.totalSteps) * 100));
}

function durSec(state: ActiveRunState): string {
	const end = state.endedAt ?? Date.now();
	const s = Math.max(0, Math.round((end - state.startedAt) / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return `${m}m ${s % 60}s`;
}

/**
 * Inline live indicator for a recipe's active or just-finished run.
 * Three density levels:
 *   "chip"     — compact "Step 2/5 · 3s" pill for the recipes-list row
 *   "strip"    — progress bar + current step + status, for the detail panel
 *   "outcome"  — terminal state with halt reason / open-run link
 */
export function RecipeRunInline({
	state,
	density = "strip",
}: {
	state: ActiveRunState;
	density?: "chip" | "strip" | "outcome";
}) {
	const tone: "ok" | "warn" | "err" | "muted" =
		state.status === "running"
			? "warn"
			: state.status === "ok"
				? "ok"
				: state.status === "halted"
					? "muted"
					: "err";
	const label =
		state.status === "running"
			? state.totalSteps > 0
				? `Step ${state.doneSteps}/${state.totalSteps}`
				: "Running"
			: state.status === "ok"
				? "Done"
				: state.status === "halted"
					? "Halted"
					: "Error";

	if (density === "chip") {
		return (
			<span
				style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "var(--fs-xs)" }}
				aria-label={`Run ${label.toLowerCase()}`}
			>
				<StatusPill tone={tone}>{label}</StatusPill>
				<span className="mono muted" style={{ fontVariantNumeric: "tabular-nums" }}>
					{durSec(state)}
				</span>
			</span>
		);
	}

	const p = pct(state);
	// "Strip" density gets a one-shot completion sweep + opacity fade over
	// the last 5s of the 30s store-GC window — makes the lifecycle legible
	// instead of cards vanishing abruptly. Classes are no-ops while the
	// run is "running"; flip on when status hits a terminal state.
	const isTerminal = state.status !== "running";
	const containerClass = isTerminal
		? "recipe-run-inline is-terminal"
		: "recipe-run-inline";
	return (
		<div
			className={containerClass}
			style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}
			role="status"
			aria-live="polite"
		>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 8,
					fontSize: "var(--fs-xs)",
					flexWrap: "wrap",
				}}
			>
				<StatusPill tone={tone}>{label}</StatusPill>
				{state.currentTool && state.status === "running" && (
					<span className="mono" style={{ color: "var(--ink-2)" }}>
						{state.currentTool}
					</span>
				)}
				<span className="mono muted" style={{ fontVariantNumeric: "tabular-nums" }}>
					{durSec(state)}
				</span>
				<span style={{ flex: 1 }} />
				{state.runSeq > 0 && (
					<Link
						href={`/runs/${state.runSeq}`}
						style={{
							fontSize: "var(--fs-xs)",
							color: "var(--ink-3)",
							textDecoration: "none",
							minHeight: 28,
							display: "inline-flex",
							alignItems: "center",
							padding: "0 6px",
						}}
					>
						open run →
					</Link>
				)}
			</div>
			{state.totalSteps > 0 && (
				<div
					className="recipe-run-inline-bar"
					aria-label={`Progress ${p}%`}
					style={{
						height: 4,
						width: "100%",
						background: "var(--bg-2)",
						borderRadius: 2,
						overflow: "hidden",
						position: "relative",
					}}
				>
					<div
						style={{
							width: `${p}%`,
							height: "100%",
							background:
								state.status === "error"
									? "var(--err)"
									: state.status === "halted"
										? "var(--warn)"
										: state.status === "ok"
											? "var(--ok)"
											: "var(--accent)",
							transition: "width 0.25s ease",
						}}
					/>
				</div>
			)}
			{(state.haltReason || state.lastError) && (
				// Mid-run step errors used to be hidden until the run ended —
				// the gate `status !== "running"` swallowed any in-flight
				// failure breadcrumb. Surface them inline with a softer
				// "step failed, continuing" tone; post-run halts keep the
				// stronger err background.
				<div
					className="mono"
					style={{
						fontSize: "var(--fs-2xs)",
						color: state.status === "running" ? "var(--warn)" : "var(--ink-3)",
						background:
							state.status === "running"
								? "color-mix(in srgb, var(--warn) 10%, transparent)"
								: "var(--bg-2)",
						padding: "4px 6px",
						borderRadius: 4,
						wordBreak: "break-word",
					}}
				>
					{state.status === "running" && state.lastError ? (
						<>
							<span style={{ fontWeight: 600 }}>Step failed — </span>
							{state.lastError}
						</>
					) : (
						state.haltReason ?? state.lastError
					)}
				</div>
			)}
		</div>
	);
}
