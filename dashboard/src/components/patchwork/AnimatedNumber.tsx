"use client";
import { useEffect, useRef, useState } from "react";

export function AnimatedNumber({
  value,
  duration = 1200,
  format = (n: number) => Math.round(n).toLocaleString(),
}: {
  value: number;
  duration?: number;
  format?: (n: number) => string;
}) {
  const [n, setN] = useState(value);
  const fromRef = useRef(value);
  const startRef = useRef<number | null>(null);
  const prevValueRef = useRef(value);
  // Flash key bumps whenever the input value actually changes, so the
  // wrapping span can drive a one-shot CSS animation on its own without
  // colliding with the counter-up rAF loop.
  const [flashKey, setFlashKey] = useState(0);
  const flashTone = useRef<"up" | "down" | null>(null);

  useEffect(() => {
    if (prevValueRef.current !== value) {
      flashTone.current = value > prevValueRef.current ? "up" : "down";
      setFlashKey((k) => k + 1);
      prevValueRef.current = value;
    }
    const from = fromRef.current;
    const target = value;
    startRef.current = null;
    let raf = 0;
    const tick = (t: number) => {
      if (startRef.current == null) startRef.current = t;
      const p = Math.min(1, (t - startRef.current) / duration);
      const eased = 1 - (1 - p) ** 3;
      const next = from + (target - from) * eased;
      setN(next);
      fromRef.current = next;
      if (p < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  return (
    <span
      // Skip the flash class on the very first mount (flashKey === 0) so
      // the page doesn't pulse on initial render — only when a value
      // changes after that.
      className={
        flashKey > 0
          ? `animated-number-flash animated-number-flash-${flashTone.current ?? "up"}`
          : undefined
      }
      key={flashKey}
    >
      {format(n)}
    </span>
  );
}
