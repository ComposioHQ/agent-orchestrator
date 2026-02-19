"use client";

import { useEffect, useRef } from "react";

/**
 * Subscribe to a Server-Sent Events stream with auto-reconnect.
 *
 * Handles the full connection lifecycle: mounted guard, 3-second error retry,
 * and cleanup on unmount. Uses a ref for `onMessage` so callers don't need to
 * memoize the callback — the latest version is always called without
 * re-triggering the effect.
 *
 * @param url       SSE endpoint URL (reconnects if this changes)
 * @param onMessage Called for each `message` event with the parsed JSON payload
 */
export function useSSE<T>(url: string, onMessage: (data: T) => void): void {
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    let mounted = true;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      es = new EventSource(url);

      es.onmessage = (event: MessageEvent<string>) => {
        let parsed: T;
        try {
          parsed = JSON.parse(event.data) as T;
        } catch {
          // Ignore malformed JSON — don't let a bad frame stop the stream.
          return;
        }
        // Invoke outside the try/catch so callback errors surface normally
        // (logged by the browser) rather than being silently swallowed.
        onMessageRef.current(parsed);
      };

      es.onerror = () => {
        es?.close();
        es = null;
        // Guard against scheduling a retry after the component has unmounted.
        if (!mounted || retryTimer) return;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (mounted) connect();
        }, 3000);
      };
    };

    connect();

    return () => {
      mounted = false;
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
    };
  }, [url]);
}
