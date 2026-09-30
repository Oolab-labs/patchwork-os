/**
 * Butler Loose Ends — temporary unfinished things, deliberately separate from
 * Butler's durable belief store.
 *
 * A loose end is something like "buy batteries", "I promised David the book",
 * or "waiting for a refund". It is NOT a fact Butler should carry forever as
 * part of its model of the user.
 */

export const OPEN_LOOP_RV = 1 as const;

export type OpenLoopKind = "remember" | "promise" | "waiting" | "future_me";
export type OpenLoopStatus = "open" | "done";
export type OpenLoopSource = "http" | "shortcut" | "import";

export interface OpenLoopCreatedEvent {
  rv: typeof OPEN_LOOP_RV;
  event: "created";
  eventId: string;
  loopId: string;
  kind: OpenLoopKind;
  text: string;
  createdAt: number;
  source: OpenLoopSource;
}

export interface OpenLoopCompletedEvent {
  rv: typeof OPEN_LOOP_RV;
  event: "completed";
  eventId: string;
  loopId: string;
  at: number;
}

export interface OpenLoopReopenedEvent {
  rv: typeof OPEN_LOOP_RV;
  event: "reopened";
  eventId: string;
  loopId: string;
  at: number;
}

export interface OpenLoopErasedEvent {
  rv: typeof OPEN_LOOP_RV;
  event: "erased";
  eventId: string;
  loopId: string;
  erasedAt: number;
}

export type OpenLoopEvent =
  | OpenLoopCreatedEvent
  | OpenLoopCompletedEvent
  | OpenLoopReopenedEvent
  | OpenLoopErasedEvent;

export interface OpenLoop {
  id: string;
  kind: OpenLoopKind;
  text: string;
  source: OpenLoopSource;
  createdAt: number;
  status: OpenLoopStatus;
  completedAt?: number;
}

export interface OpenLoopBriefItem {
  id: string;
  kind: OpenLoopKind;
  text: string;
  reason: "Still open";
}

export const OPEN_LOOP_KINDS: ReadonlySet<OpenLoopKind> = new Set([
  "remember",
  "promise",
  "waiting",
  "future_me",
]);

export const MAX_OPEN_LOOP_TEXT_CHARS = 1024;
