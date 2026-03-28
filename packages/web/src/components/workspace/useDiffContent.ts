"use client";

import { useState, useCallback, useEffect, useRef } from "react";

export interface DiffContentResponse {
  path: string;
  status: string;
  diff: string | null;
  content: string | null;
}

interface DiffErrorBody {
  error: string;
  message?: string;
  path?: string;
}

interface UseDiffContentState {
  data: DiffContentResponse | null;
  error: DiffErrorBody | null;
  loading: boolean;
}

function diffUrl(sessionId: string, filePath: string): string {
  const segments = filePath.split("/").filter(Boolean).map(encodeURIComponent);
  return `/api/sessions/${encodeURIComponent(sessionId)}/diff/${segments.join("/")}`;
}

export function useDiffContent(sessionId: string, filePath: string | null) {
  const [state, setState] = useState<UseDiffContentState>({
    data: null,
    error: null,
    loading: !!filePath,
  });

  const etagRef = useRef<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    etagRef.current = null;
  }, [filePath]);

  const fetchDiff = useCallback(async () => {
    if (!filePath) {
      setState({ data: null, error: null, loading: false });
      return;
    }

    try {
      const headers: Record<string, string> = {};
      if (etagRef.current) {
        headers["If-None-Match"] = etagRef.current;
      }

      const res = await fetch(diffUrl(sessionId, filePath), { headers });

      if (res.status === 304) {
        return;
      }

      if (res.status === 422) {
        const body = (await res.json()) as DiffErrorBody;
        setState({ data: null, error: body, loading: false });
        return;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const etag = res.headers.get("ETag");
      if (etag) {
        etagRef.current = etag;
      }

      const data = (await res.json()) as DiffContentResponse;
      setState({ data, error: null, loading: false });
    } catch (err) {
      console.error("Failed to fetch diff:", err);
      setState({
        data: null,
        error: {
          error: "fetch_error",
          message: "Failed to fetch diff",
          path: filePath,
        },
        loading: false,
      });
    }
  }, [sessionId, filePath]);

  useEffect(() => {
    if (!filePath) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setState({ data: null, error: null, loading: false });
      return;
    }

    setState({ data: null, error: null, loading: true });
    void fetchDiff();
    intervalRef.current = setInterval(() => {
      void fetchDiff();
    }, 5000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [filePath, fetchDiff]);

  return {
    data: state.data,
    error: state.error,
    loading: state.loading,
  };
}
