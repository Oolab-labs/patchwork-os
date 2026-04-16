import {
  error,
  success,
  successLarge,
  successStructured,
  successStructuredLarge,
} from "../tools/utils.js";

export type BridgeErrorCode =
  | "invalid_arg"
  | "workspace_escape"
  | "extension_required"
  | "extension_timeout"
  | "rate_limited"
  | "task_not_found"
  | "exec_failed"
  | "timeout"
  | "not_found"
  | "validation_error"
  | "unknown";

export type ToolResult<T> =
  | { ok: true; shape: "plain"; value: T }
  | { ok: true; shape: "structured"; value: T }
  | { ok: true; shape: "large"; value: T }
  | { ok: true; shape: "structuredLarge"; value: T }
  | { ok: false; code: BridgeErrorCode | string; message: string };

export const ok = <T>(value: T): ToolResult<T> => ({
  ok: true,
  shape: "plain",
  value,
});

export const okS = <T>(value: T): ToolResult<T> => ({
  ok: true,
  shape: "structured",
  value,
});

export const okL = <T>(value: T): ToolResult<T> => ({
  ok: true,
  shape: "large",
  value,
});

export const okSL = <T>(value: T): ToolResult<T> => ({
  ok: true,
  shape: "structuredLarge",
  value,
});

export const err = <T = never>(
  code: BridgeErrorCode | string,
  message: string,
): ToolResult<T> => ({ ok: false, code, message });

export function toCallToolResult<T>(r: ToolResult<T>) {
  if (!r.ok) return error(r.message, r.code);
  switch (r.shape) {
    case "plain":
      return success(r.value);
    case "structured":
      return successStructured(r.value);
    case "large":
      return successLarge(r.value);
    case "structuredLarge":
      return successStructuredLarge(r.value);
  }
}

export function mapResult<T, U>(
  r: ToolResult<T>,
  f: (v: T) => U,
): ToolResult<U> {
  if (!r.ok) return r;
  return { ...r, value: f(r.value) };
}

export function flatMapResult<T, U>(
  r: ToolResult<T>,
  f: (v: T) => ToolResult<U>,
): ToolResult<U> {
  if (!r.ok) return r;
  return f(r.value);
}

export function legacyParseArgs<T>(
  fn: () => T,
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): ToolResult<T> {
  try {
    return ok(fn());
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger?.warn("arg validation failure", { message });
    return err("invalid_arg", message);
  }
}
