"use client";

import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export type ToastVariant = "success" | "error" | "info" | "warn";

export type ToastOptions = {
  variant?: ToastVariant;
  /** Milliseconds before auto-dismiss. 0 disables auto-dismiss. Default 5000. */
  duration?: number;
  /** Optional action button. */
  action?: { label: string; onClick: () => void };
  /** Stable id; if provided and a toast with this id already exists, it is replaced. */
  id?: string;
};

type Toast = Required<Pick<ToastOptions, "variant" | "duration">> & {
  id: string;
  message: string;
  action?: ToastOptions["action"];
};

type ToastApi = {
  toast: (message: string, opts?: ToastOptions) => string;
  success: (message: string, opts?: Omit<ToastOptions, "variant">) => string;
  error: (message: string, opts?: Omit<ToastOptions, "variant">) => string;
  info: (message: string, opts?: Omit<ToastOptions, "variant">) => string;
  warn: (message: string, opts?: Omit<ToastOptions, "variant">) => string;
  dismiss: (id: string) => void;
};

const ToastCtx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) {
    // Fallback: never throw; allow components to call useToast without a provider
    // (e.g. in tests), no-oping silently.
    return {
      toast: () => "",
      success: () => "",
      error: () => "",
      info: () => "",
      warn: () => "",
      dismiss: () => {},
    };
  }
  return ctx;
}

let counter = 0;
const nextId = () => `t${Date.now().toString(36)}-${(counter++).toString(36)}`;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
    setToasts((curr) => curr.filter((x) => x.id !== id));
  }, []);

  const push = useCallback(
    (message: string, opts?: ToastOptions) => {
      const id = opts?.id ?? nextId();
      const variant = opts?.variant ?? "info";
      const duration = opts?.duration ?? 5000;
      const t: Toast = { id, message, variant, duration, action: opts?.action };
      setToasts((curr) => {
        const without = curr.filter((x) => x.id !== id);
        // Cap at 5 visible.
        const trimmed = without.length >= 5 ? without.slice(without.length - 4) : without;
        return [...trimmed, t];
      });
      const existing = timers.current.get(id);
      if (existing) clearTimeout(existing);
      if (duration > 0) {
        const handle = setTimeout(() => dismiss(id), duration);
        timers.current.set(id, handle);
      }
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    return () => {
      for (const handle of timers.current.values()) clearTimeout(handle);
      timers.current.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      toast: (m, o) => push(m, o),
      success: (m, o) => push(m, { ...o, variant: "success" }),
      error: (m, o) => push(m, { ...o, variant: "error", duration: o?.duration ?? 7000 }),
      info: (m, o) => push(m, { ...o, variant: "info" }),
      warn: (m, o) => push(m, { ...o, variant: "warn" }),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} dismiss={dismiss} />
    </ToastCtx.Provider>
  );
}

function variantStyles(v: ToastVariant): {
  bg: string;
  border: string;
  fg: string;
  iconColor: string;
  icon: string;
} {
  switch (v) {
    case "success":
      return {
        bg: "var(--green-soft)",
        border: "var(--green)",
        fg: "var(--ink-0)",
        iconColor: "var(--green)",
        icon: "✓",
      };
    case "error":
      return {
        bg: "var(--red-soft)",
        border: "var(--red)",
        fg: "var(--ink-0)",
        iconColor: "var(--red)",
        icon: "!",
      };
    case "warn":
      return {
        bg: "var(--amber-soft, var(--warn-soft))",
        border: "var(--amber, var(--warn))",
        fg: "var(--ink-0)",
        iconColor: "var(--amber, var(--warn))",
        icon: "!",
      };
    default:
      return {
        bg: "var(--surface)",
        border: "var(--line-2)",
        fg: "var(--ink-0)",
        iconColor: "var(--ink-2)",
        icon: "i",
      };
  }
}

function ToastViewport({
  toasts,
  dismiss,
}: {
  toasts: Toast[];
  dismiss: (id: string) => void;
}) {
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      role="region"
      aria-label="Toast notifications"
      data-toast-viewport
      style={{
        position: "fixed",
        bottom: 16,
        right: 16,
        zIndex: 1100,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        pointerEvents: "none",
        maxWidth: "min(calc(100vw - 32px), 420px)",
      }}
    >
      {toasts.map((t) => {
        const s = variantStyles(t.variant);
        return (
          <div
            key={t.id}
            role={t.variant === "error" ? "alert" : "status"}
            style={{
              pointerEvents: "auto",
              background: s.bg,
              color: s.fg,
              border: `1px solid ${s.border}`,
              borderRadius: "var(--r-2, 10px)",
              boxShadow: "var(--shadow-modal, 0 10px 30px rgba(0,0,0,0.18))",
              padding: "10px 12px",
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              fontSize: 13,
              lineHeight: 1.4,
              animation: "patchwork-toast-in 160ms ease-out",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                flex: "0 0 auto",
                width: 18,
                height: 18,
                borderRadius: "50%",
                background: s.iconColor,
                color: "var(--surface)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 11,
                fontWeight: 700,
                marginTop: 1,
              }}
            >
              {s.icon}
            </span>
            <div style={{ flex: 1, minWidth: 0, wordBreak: "break-word" }}>{t.message}</div>
            {t.action ? (
              <button
                type="button"
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
                style={{
                  flex: "0 0 auto",
                  background: "transparent",
                  border: "1px solid var(--line-2)",
                  borderRadius: 6,
                  padding: "2px 8px",
                  fontSize: 12,
                  color: "var(--ink-0)",
                  cursor: "pointer",
                }}
              >
                {t.action.label}
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => dismiss(t.id)}
              style={{
                flex: "0 0 auto",
                background: "transparent",
                border: "none",
                color: "var(--ink-2)",
                cursor: "pointer",
                fontSize: 16,
                lineHeight: 1,
                padding: 0,
                marginLeft: 2,
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      <style>{`@keyframes patchwork-toast-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }`}</style>
    </div>
  );
}
