"use client";

import { useEffect, useReducer } from "react";
import type {
  Proposal,
  Fork,
  GovernanceTimelineEvent,
  GovernanceSSESnapshot,
  GovernanceState,
} from "@/lib/governance-types";

type Action =
  | { type: "reset"; proposals: Proposal[]; forks: Fork[]; timeline: GovernanceTimelineEvent[] }
  | { type: "snapshot"; data: GovernanceSSESnapshot }
  | { type: "select_fork"; forkId: string | null }
  | { type: "set_loading"; loading: boolean };

function reducer(state: GovernanceState, action: Action): GovernanceState {
  switch (action.type) {
    case "reset":
      return {
        ...state,
        proposals: action.proposals,
        forks: action.forks,
        timeline: action.timeline,
        loading: false,
      };
    case "snapshot": {
      return {
        ...state,
        proposals: action.data.proposals,
        forks: action.data.forks,
        timeline: action.data.timeline,
        loading: false,
      };
    }
    case "select_fork":
      return { ...state, selectedForkId: action.forkId };
    case "set_loading":
      return { ...state, loading: action.loading };
  }
}

export function useGovernanceEvents(forkId?: string | null): {
  state: GovernanceState;
  selectFork: (forkId: string | null) => void;
} {
  const [state, dispatch] = useReducer(reducer, {
    proposals: [],
    forks: [],
    timeline: [],
    selectedForkId: forkId ?? null,
    loading: true,
  });

  useEffect(() => {
    const forkParam = forkId ? `?fork=${encodeURIComponent(forkId)}` : "";
    const url = `/api/governance/events${forkParam}`;
    const es = new EventSource(url);
    let disposed = false;

    es.onmessage = (event: MessageEvent) => {
      if (disposed) return;
      try {
        const data = JSON.parse(event.data as string) as GovernanceSSESnapshot;
        if (data.type === "governance_snapshot") {
          dispatch({ type: "snapshot", data });
        }
      } catch {
        return;
      }
    };

    es.onerror = () => undefined;

    return () => {
      disposed = true;
      es.close();
    };
  }, [forkId]);

  const selectFork = (id: string | null) => {
    dispatch({ type: "select_fork", forkId: id });
  };

  return { state, selectFork };
}
