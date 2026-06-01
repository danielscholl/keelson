import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

export type ToastKind = "ok" | "error" | "info";

// An optional one-click action (e.g. Undo) rendered beside the dismiss button.
export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastEntry {
  id: number;
  kind: ToastKind;
  message: string;
  // ttlMs of 0 means sticky — caller can dismiss manually.
  ttlMs: number;
  action?: ToastAction;
}

interface ToastApi {
  push: (toast: {
    kind: ToastKind;
    message: string;
    ttlMs?: number;
    action?: ToastAction;
  }) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Falling back instead of throwing keeps non-Chat surfaces safe even
    // if someone calls useToast() outside the provider tree.
    return {
      push: () => 0,
      dismiss: () => undefined,
    };
  }
  return ctx;
}

const DEFAULT_TTL_BY_KIND: Record<ToastKind, number> = {
  ok: 3500,
  info: 4500,
  error: 6000,
};

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const idRef = useRef(0);
  // Track timeouts so dismiss() can clear them; otherwise a ttl fire after
  // manual dismiss would call setToasts on a stale id (no-op, but noisy).
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback<ToastApi["push"]>(({ kind, message, ttlMs, action }) => {
    const id = ++idRef.current;
    const ttl = ttlMs ?? DEFAULT_TTL_BY_KIND[kind];
    setToasts((prev) => [
      ...prev,
      { id, kind, message, ttlMs: ttl, ...(action ? { action } : {}) },
    ]);
    if (ttl > 0) {
      const timer = setTimeout(() => {
        timersRef.current.delete(id);
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, ttl);
      timersRef.current.set(id, timer);
    }
    return id;
  }, []);

  // Cleanup on unmount — orphaned timers would call setToasts after the
  // component is gone (warns in strict mode).
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ push, dismiss }}>
      {children}
      <div className="toast-host" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`keelson-toast keelson-toast-${t.kind}`}>
            <span className="toast-message">{t.message}</span>
            {t.action ? (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            ) : null}
            <button
              type="button"
              className="toast-close"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
