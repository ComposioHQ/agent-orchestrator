"use client";

import { useState, useCallback, useEffect } from "react";
import type { FileNode } from "@/app/api/sessions/[id]/files/route";

type GitStatus = "M" | "A" | "D" | "?" | "R";

export interface FileTreeState {
  tree: FileNode[];
  gitStatus: Record<string, GitStatus>;
}

export function useFileTree(sessionId: string) {
  const [state, setState] = useState<FileTreeState>({ tree: [], gitStatus: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchFileTree = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as FileTreeState;
      setState(data);
      setError(null);
    } catch (err) {
      console.error("Failed to fetch file tree:", err);
      setError("Failed to load file tree");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Initial fetch
  useEffect(() => {
    fetchFileTree();
  }, [fetchFileTree]);

  // Poll for updates every 5 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      fetchFileTree();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchFileTree]);

  return {
    tree: state.tree,
    gitStatus: state.gitStatus,
    loading,
    error,
  };
}
