"use client";

import {
  type ChangeEvent,
  type CSSProperties,
  type TextareaHTMLAttributes,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";

/**
 * Drop-in replacement for `<textarea>` that auto-resizes its height to
 * fit content as the user types or pastes.
 *
 * Why: pasting >3 rows of content into a fixed `rows={3}` textarea
 * leaves the user scrolling inside a 66 px window — the audit found
 * users assumed something was broken when 1100 chars vanished into a
 * 3-line scroll buffer.
 *
 * Implementation: on every value change, set height to "auto" (collapse
 * to one row), read scrollHeight (now reflects the wrapped content),
 * then set height to that value (capped by the prop). useLayoutEffect
 * so the resize happens before paint and avoids a flash.
 */

interface Props
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "ref"> {
  /** Maximum height in px before scrolling kicks in. Default 400. */
  maxHeight?: number;
  /** Minimum height in px. Defaults to the textarea's `rows` × line height. */
  minHeight?: number;
}

export function AutoGrowTextarea({
  maxHeight = 400,
  minHeight,
  style,
  onChange,
  value,
  ...rest
}: Props) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const resize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${Math.max(next, minHeight ?? 0)}px`;
  };

  // Resize on every value change. useLayoutEffect (not useEffect) so the
  // height update is committed before paint — avoids a 1-frame jump.
  useLayoutEffect(() => {
    resize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, maxHeight, minHeight]);

  // Resize once on mount in case server-rendered HTML (initial value)
  // wraps differently than the empty case the rows attribute assumes.
  useEffect(() => {
    resize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    onChange?.(e);
  };

  const mergedStyle: CSSProperties = {
    overflowY: "auto",
    resize: "none",
    ...style,
  };

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={handleChange}
      style={mergedStyle}
      {...rest}
    />
  );
}
