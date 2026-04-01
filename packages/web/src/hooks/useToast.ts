"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface Toast {
  id: string;
  message: string;
  type: "error" | "success";
  createdAt: number;
}

const AUTO_DISMISS_MS = 5_000;
let nextId = 0;

export function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const showToast = useCallback(
    (message: string, type: "error" | "success") => {
      const id = `toast-${++nextId}`;
      const toast: Toast = { id, message, type, createdAt: Date.now() };
      setToasts((prev) => [...prev, toast]);

      const timer = setTimeout(() => {
        dismissToast(id);
      }, AUTO_DISMISS_MS);
      timersRef.current.set(id, timer);

      return id;
    },
    [dismissToast],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  return { toasts, showToast, dismissToast };
}
