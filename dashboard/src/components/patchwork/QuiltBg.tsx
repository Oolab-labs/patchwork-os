"use client";
import { useEffect, useMemo, useState } from "react";

const PALETTE = [
  "var(--orange)",
  "var(--orange-soft)",
  "var(--quilt-soft)",
  "transparent",
  "transparent",
  "transparent",
  "var(--ink-3)",
  "var(--pressed)",
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
  // the visual richness isn't just a deterministic checker pattern.
  useEffect(() => {
    setCells((prev) =>
      prev.map((c) => ({
        ...c,
        fill: PALETTE[Math.floor(Math.random() * PALETTE.length)],
      })),
    );
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      setCells((prev) => {
        const next = prev.slice();
        const flips = 3 + Math.floor(Math.random() * 3);
        for (let i = 0; i < flips; i++) {
          const idx = Math.floor(Math.random() * next.length);
          next[idx] = { ...next[idx], fill: PALETTE[Math.floor(Math.random() * PALETTE.length)] };
        }
        return next;
      });
    }, 1400);
    return () => clearInterval(id);
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
        <style>{`
          @keyframes quilt-in {
            0%   { opacity: 0; transform: scale(0.4); transform-box: fill-box; transform-origin: center; }
            100% { opacity: 1; transform: scale(1); transform-box: fill-box; transform-origin: center; }
          }
        `}</style>
      </svg>
    </div>
  );
}
