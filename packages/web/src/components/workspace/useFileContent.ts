"use client";

import { useState, useCallback, useEffect, useRef } from "react";

interface FileContentResponse {
  content: string;
  path: string;
  size: number;
  mtime: string;
}

interface FileError {
  error: string;
  message: string;
  path: string;
  size: number;
}

interface UseFileContentState {
  data: FileContentResponse | null;
  error: FileError | null;
  loading: boolean;
}

export function useFileContent(sessionId: string, filePath: string | null) {
  const [state, setState] = useState<UseFileContentState>({
    data: null,
    error: null,
    loading: !!filePath,
  });

  const etagRef = useRef<string | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchFileContent = useCallback(async () => {
    if (!filePath) {
      setState({ data: null, error: null, loading: false });
      return;
    }

    try {
      const headers: Record<string, string> = {};
      if (etagRef.current) {
        headers["If-None-Match"] = etagRef.current;
      }

      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(filePath)}`,
        { headers }
      );

      // 304 Not Modified - content hasn't changed
      if (res.status === 304) {
        return;
      }

      // 422 - Binary or too large
      if (res.status === 422) {
        const error = (await res.json()) as FileError;
        setState({ data: null, error, loading: false });
        return;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const etag = res.headers.get("ETag");
      if (etag) {
        etagRef.current = etag;
      }

      const data = (await res.json()) as FileContentResponse;
      setState({ data, error: null, loading: false });
    } catch (err) {
      console.error("Failed to fetch file content:", err);
      setState({
        data: null,
        error: {
          error: "fetch_error",
          message: "Failed to fetch file content",
          path: filePath,
          size: 0,
        },
        loading: false,
      });
    }
  }, [sessionId, filePath]);

  // Initial fetch
  useEffect(() => {
    fetchFileContent();
  }, [fetchFileContent]);

  // Poll for updates every 5 seconds
  useEffect(() => {
    if (!filePath) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    // Initial fetch
    fetchFileContent();

    // Set up polling
    intervalRef.current = setInterval(() => {
      fetchFileContent();
    }, 5000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [filePath, fetchFileContent]);

  return {
    data: state.data,
    error: state.error,
    loading: state.loading,
  };
}
