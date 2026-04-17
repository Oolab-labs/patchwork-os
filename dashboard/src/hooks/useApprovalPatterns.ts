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

interface ApprovalDecisionEvent {
  toolName: string;
  decision: "approve" | "reject";
}

function isApprovalDecisionEvent(data: unknown): data is ApprovalDecisionEvent {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.toolName === "string" &&
    (d.decision === "approve" || d.decision === "reject")
  );
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
    if (type !== "approval_decision") return;
    if (!isApprovalDecisionEvent(data)) return;

    const { toolName, decision } = data;
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
