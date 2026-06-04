"use client";
import { useEffect, useMemo, useState } from "react";

// Theme-redesign AP-03: neutral tile palette — no orange/ink bleeding through
// the hero text mask. Quiet surface tones + transparency only; the mosaic is a
// texture, not a competing color field.
const PALETTE = [
  "var(--recess)",
  "var(--pressed)",
  "var(--surface)",
  "var(--quilt-soft)",
  "transparent",
  "transparent",
  "transparent",
  "var(--canvas)",
];

interface Cell {
  id: string;
  x: number;
  y: number;
  fill: string;
  enterDelay: number;
}

export function QuiltBg({
  cols = 20,
  rows = 7,
  size = 36,
}: {
  cols?: number;
  rows?: number;
  size?: number;
}) {
  // Deterministic initial layout — Math.random() on either side of SSR
  // hydration causes mismatch warnings (server/client get different
  // delays + fills). Use a tiny mulberry32-ish hash off (r,c) so SSR and
  // first client render agree, then randomise post-mount.
  const initial = useMemo<Cell[]>(() => {
    const cells: Cell[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const h = (r * 73856093) ^ (c * 19349663);
        const fillIdx = Math.abs(h) % PALETTE.length;
        const delayJitter = (Math.abs(h >> 8) % 200);
        cells.push({
          id: `${r}-${c}`,
          x: c * size,
          y: r * size,
          fill: PALETTE[fillIdx],
          enterDelay: (r + c) * 50 + delayJitter,
        });
      }
    }
    return cells;
  }, [cols, rows, size]);

  const [cells, setCells] = useState<Cell[]>(initial);

  // After mount, splash a fresh randomised palette across the grid so
  // the visual richness isn't just a deterministic checker pattern. Skip
  // when the user has prefers-reduced-motion set — they get the stable
  // deterministic layout.
  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    setCells((prev) =>
      prev.map((c) => ({
        ...c,
        fill: PALETTE[Math.floor(Math.random() * PALETTE.length)],
      })),
    );
  }, []);

  // Background mosaic flicker — gated on (a) prefers-reduced-motion, and
  // (b) document.visibilityState. Without (a), reduced-motion users still
  // see the cells re-flip every 1.4 s. Without (b), the timer keeps firing
  // on hidden tabs, repainting 140 cells off-screen.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduced.matches) return;

    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id !== null) return;
      id = setInterval(() => {
        setCells((prev) => {
          const next = prev.slice();
          const flips = 3 + Math.floor(Math.random() * 3);
          for (let i = 0; i < flips; i++) {
            const idx = Math.floor(Math.random() * next.length);
            next[idx] = {
              ...next[idx],
              fill: PALETTE[Math.floor(Math.random() * PALETTE.length)],
            };
          }
          return next;
        });
      }, 2800);
    };
    const stop = () => {
      if (id !== null) {
        clearInterval(id);
        id = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };
    const onMotionChange = () => {
      if (reduced.matches) stop();
      else if (document.visibilityState === "visible") start();
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    reduced.addEventListener("change", onMotionChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      reduced.removeEventListener("change", onMotionChange);
    };
  }, []);

  return (
    <div className="quilt-bg" aria-hidden="true">
      <svg viewBox={`0 0 ${cols * size} ${rows * size}`} preserveAspectRatio="xMidYMid slice">
        <defs>
          <pattern id="stitchPat" x="0" y="0" width={size} height={size} patternUnits="userSpaceOnUse">
            <path
              d={`M0 ${size / 2} L${size} ${size / 2} M${size / 2} 0 L${size / 2} ${size}`}
              stroke="var(--stitch-line)"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
          </pattern>
        </defs>
        {cells.map((c) => (
          <rect
            key={c.id}
            x={c.x + 2}
            y={c.y + 2}
            width={size - 4}
            height={size - 4}
            rx={4}
            fill={c.fill}
            style={{
              transition: "fill 0.9s cubic-bezier(.2,.7,.2,1)",
              animation: `quilt-in 0.6s ${c.enterDelay}ms cubic-bezier(.2,.7,.2,1) both`,
            }}
          />
        ))}
        <rect width={cols * size} height={rows * size} fill="url(#stitchPat)" />
      </svg>
    </div>
  );
}
