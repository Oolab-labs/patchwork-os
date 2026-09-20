import type { OpenLoop, OpenLoopEvent } from "./openLoopTypes.js";

/**
 * Pure deterministic fold over the event log.
 *
 * File order is the event order. Unknown/malformed rows never reach this
 * function; the store filters them while reading. A completion or reopen for
 * an unknown id is ignored here and rejected on the write path.
 */
export function resolveOpenLoops(events: readonly OpenLoopEvent[]): OpenLoop[] {
  const loops = new Map<string, OpenLoop>();
  const erased = new Set<string>();

  for (const event of events) {
    if (event.event === "erased") {
      erased.add(event.loopId);
      loops.delete(event.loopId);
      continue;
    }
    if (erased.has(event.loopId)) continue;

    if (event.event === "created") {
      // UUID ids make duplicates extraordinarily unlikely, but a duplicate
      // created row must not silently replace the original record.
      if (!loops.has(event.loopId)) {
        loops.set(event.loopId, {
          id: event.loopId,
          kind: event.kind,
          text: event.text,
          source: event.source,
          createdAt: event.createdAt,
          status: "open",
        });
      }
      continue;
    }

    const loop = loops.get(event.loopId);
    if (!loop) continue;

    if (event.event === "completed") {
      loops.set(event.loopId, {
        ...loop,
        status: "done",
        completedAt: event.at,
      });
    } else if (event.event === "reopened") {
      loops.set(event.loopId, {
        id: loop.id,
        kind: loop.kind,
        text: loop.text,
        source: loop.source,
        createdAt: loop.createdAt,
        status: "open",
      });
    }
  }

  return [...loops.values()].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
}
