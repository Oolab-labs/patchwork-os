"use client";
import { useCallback, useRef, useState } from "react";
import { useBridgeStream } from "./useBridgeStream";

export interface ToolPattern {
  approved: number;
  rejected: number;
  lastSeen: number;
}

const STORAGE_KEY = "patchwork-approval-patterns";
const EXPIRY_MS = 30 * 24 * 3600 * 1000;

function loadFromStorage(): Map<string, ToolPattern> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as Record<string, ToolPattern>;
    const now = Date.now();
    const map = new Map<string, ToolPattern>();
    for (const [key, val] of Object.entries(parsed)) {
      if (now - val.lastSeen <= EXPIRY_MS) {
        map.set(key, val);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function saveToStorage(map: Map<string, ToolPattern>): void {
  try {
    const obj: Record<string, ToolPattern> = {};
    for (const [key, val] of map) {
      obj[key] = val;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // localStorage unavailable — silently skip
  }
}

interface ApprovalDecision {
  toolName: string;
  decision: "approve" | "reject";
}

/**
 * Extract `{toolName, decision}` from a bridge SSE frame, or null if
 * it isn't an approval-decision event.
 *
 * The bridge emits `{kind:"lifecycle", event, metadata:{...}}`. The
 * approval-decision payload carries `toolName` + `decision` inside
 * `metadata` — NOT at the top level. The previous predicate checked
 * the top level, so it never matched even when the event was the
 * right kind. (Compounding bug: the consumer also guarded on the
 * SSE frame type, which was always "message" — see useBridgeStream.)
 */
function readApprovalDecision(data: unknown): ApprovalDecision | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.event !== "approval_decision") return null;
  const md = d.metadata;
  if (!md || typeof md !== "object") return null;
  const m = md as Record<string, unknown>;
  if (typeof m.toolName !== "string") return null;
  if (m.decision !== "approve" && m.decision !== "reject") return null;
  return { toolName: m.toolName, decision: m.decision };
}

export function useApprovalPatterns(): {
  patterns: Map<string, ToolPattern>;
  clearPatterns: () => void;
} {
  const [patterns, setPatterns] = useState<Map<string, ToolPattern>>(() =>
    loadFromStorage(),
  );

  // Keep a ref so the SSE callback can read/write without stale closure
  const patternsRef = useRef(patterns);
  patternsRef.current = patterns;

  const onEvent = useCallback((type: string, data: unknown) => {
    // The shared stream tags frames by `kind` — approval decisions
    // arrive as kind:"lifecycle". Filter to lifecycle, then pull the
    // decision out of the metadata envelope.
    if (type !== "lifecycle") return;
    const decided = readApprovalDecision(data);
    if (!decided) return;

    const { toolName, decision } = decided;
    const prev = patternsRef.current;
    const existing = prev.get(toolName) ?? {
      approved: 0,
      rejected: 0,
      lastSeen: 0,
    };
    const updated: ToolPattern = {
      approved: existing.approved + (decision === "approve" ? 1 : 0),
      rejected: existing.rejected + (decision === "reject" ? 1 : 0),
      lastSeen: Date.now(),
    };
    const next = new Map(prev);
    next.set(toolName, updated);
    saveToStorage(next);
    setPatterns(next);
  }, []);

  useBridgeStream("/api/bridge/stream", onEvent);

  const clearPatterns = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    setPatterns(new Map());
  }, []);

  return { patterns, clearPatterns };
}
