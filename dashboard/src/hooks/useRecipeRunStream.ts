"use client";
import { useEffect, useRef, useState } from "react";
import { useBridgeStream } from "./useBridgeStream";

export interface ActiveRunState {
	runSeq: number;
	recipeName: string;
	totalSteps: number;
	doneSteps: number;
	currentStepId?: string;
	currentTool?: string;
	startedAt: number;
	endedAt?: number;
	status: "running" | "ok" | "error" | "halted";
	haltReason?: string;
	haltCategory?: string;
	lastError?: string;
}

interface LifecycleEvent {
	event?: string;
	metadata?: {
		runSeq?: number;
		recipeName?: string;
		stepId?: string;
		tool?: string;
		status?: "ok" | "error" | "skipped";
		error?: string;
		durationMs?: number;
		totalSteps?: number;
		haltReason?: string;
		haltCategory?: string;
	};
	ts?: number;
}

const FINAL_HOLD_MS = 30_000; // keep terminal state visible 30s, then GC

/**
 * Subscribe to ActivityLog SSE and aggregate per-recipe live run state.
 * Foundation for inline run observability on /recipes — emits the events
 * shipped by yamlRunner / chainedRunner (recipe_started, recipe_step_start,
 * recipe_step_done, recipe_done).
 *
 * Keyed by recipeName, not runSeq, so the recipes-list row knows whether
 * "its" run is live without needing to discover the runSeq first.
 */
export function useRecipeRunStream(): {
	active: Map<string, ActiveRunState>;
	connected: boolean;
} {
	const [active, setActive] = useState<Map<string, ActiveRunState>>(new Map());
	const gcTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

	useEffect(() => {
		const timers = gcTimers.current;
		return () => {
			for (const t of timers.values()) clearTimeout(t);
			timers.clear();
		};
	}, []);

	const onEvent = (type: string, raw: unknown) => {
		if (type !== "lifecycle") return;
		const data = raw as LifecycleEvent | undefined;
		const md = data?.metadata;
		if (!data?.event || !md) return;
		const name = md.recipeName;
		if (!name) return;

		if (data.event === "recipe_started") {
			setActive((prev) => {
				const next = new Map(prev);
				next.set(name, {
					runSeq: md.runSeq ?? 0,
					recipeName: name,
					totalSteps: md.totalSteps ?? 0,
					doneSteps: 0,
					startedAt: data.ts ?? Date.now(),
					status: "running",
				});
				return next;
			});
			const existing = gcTimers.current.get(name);
			if (existing) {
				clearTimeout(existing);
				gcTimers.current.delete(name);
			}
		} else if (data.event === "recipe_step_start") {
			setActive((prev) => {
				const cur = prev.get(name);
				if (!cur) return prev;
				const next = new Map(prev);
				next.set(name, { ...cur, currentStepId: md.stepId, currentTool: md.tool });
				return next;
			});
		} else if (data.event === "recipe_step_done") {
			setActive((prev) => {
				const cur = prev.get(name);
				if (!cur) return prev;
				const next = new Map(prev);
				next.set(name, {
					...cur,
					doneSteps: cur.doneSteps + 1,
					lastError: md.status === "error" ? md.error : cur.lastError,
				});
				return next;
			});
		} else if (data.event === "recipe_done") {
			setActive((prev) => {
				const cur = prev.get(name);
				if (!cur) return prev;
				const next = new Map(prev);
				const status: ActiveRunState["status"] = md.haltReason
					? "halted"
					: md.status === "error"
						? "error"
						: "ok";
				next.set(name, {
					...cur,
					endedAt: data.ts ?? Date.now(),
					status,
					haltReason: md.haltReason,
					haltCategory: md.haltCategory,
				});
				return next;
			});
			// Schedule GC so terminal state lingers briefly then drops.
			const existing = gcTimers.current.get(name);
			if (existing) clearTimeout(existing);
			const timer = setTimeout(() => {
				setActive((prev) => {
					if (!prev.has(name)) return prev;
					const next = new Map(prev);
					next.delete(name);
					return next;
				});
				gcTimers.current.delete(name);
			}, FINAL_HOLD_MS);
			gcTimers.current.set(name, timer);
		}
	};

	const { connected } = useBridgeStream("/api/bridge/stream", onEvent);
	return { active, connected };
}
