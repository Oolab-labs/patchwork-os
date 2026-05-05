"use client";
import { useId } from "react";

export function WeatherRing({
  percent,
  delta,
  trend,
  mood,
  meta,
  live = true,
  label = "LOAD",
}: {
  percent: number;
  delta?: string;
  trend: number[];
  mood?: string;
  meta?: string;
  live?: boolean;
  label?: string;
}) {
  const slots = 24;
  const pct = Math.max(0, Math.min(100, percent));
  const filled = Math.round((pct / 100) * slots);
  const id = useId().replace(/:/g, "");
  const safeTrend = trend.length >= 2 ? trend : [pct, pct];
  const trendMax = Math.max(...safeTrend, 1);
  const pts = safeTrend.map((v, i) => [
    (i / (safeTrend.length - 1)) * 200,
    22 - (v / trendMax) * 18,
  ]);
  const path = pts.map(([x, y], i) => (i === 0 ? `M${x},${y}` : `L${x},${y}`)).join(" ");
  const fillPath = `${path} L200,22 L0,22 Z`;
  return (
    <div className="weather">
      <div className="weather-head">
        <span className="weather-eyebrow">{label}</span>
        {live && (
          <span className="weather-tag">
            <span className="dot-live" /> LIVE
          </span>
        )}
      </div>
      <div className="weather-readout">
        <span className="weather-pct">{Math.round(pct)}</span>
        <span className="weather-pct-unit">%</span>
        {delta && <span className="weather-delta">{delta}</span>}
      </div>
      <div className="weather-seam" aria-hidden="true">
        {Array.from({ length: slots }).map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional stitches
          <span key={i} className={`stitch ${i < filled ? "on" : "off"}`} />
        ))}
      </div>
      <div className="weather-trend" aria-hidden="true">
        <svg width="100%" height="22" viewBox="0 0 200 22" preserveAspectRatio="none">
          <defs>
            <linearGradient id={`trend-${id}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--orange)" stopOpacity="0.22" />
              <stop offset="100%" stopColor="var(--orange)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={fillPath} fill={`url(#trend-${id})`} />
          <path d={path} fill="none" stroke="var(--orange)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          {pts.map(([x, y], i) => (
            <circle
              // biome-ignore lint/suspicious/noArrayIndexKey: ordered points
              key={i}
              cx={x}
              cy={y}
              r={i === pts.length - 1 ? 2.2 : 1.2}
              fill={i === pts.length - 1 ? "var(--orange)" : "var(--ink-3)"}
            />
          ))}
        </svg>
        <div className="weather-trend-axis">
          <span>start</span>
          <span>·</span>
          <span>·</span>
          <span>·</span>
          <span>now</span>
        </div>
      </div>
      {(mood || meta) && (
        <div className="weather-mood">
          {mood && <em>{mood}</em>}
          {mood && meta && <span className="weather-mood-divider" aria-hidden="true" />}
          {meta && <span className="weather-mood-meta">{meta}</span>}
        </div>
      )}
    </div>
  );
}
