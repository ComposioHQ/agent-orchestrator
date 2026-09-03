import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { workspaceQueryKey } from "./useWorkspaceQuery";

const usePreviewData = import.meta.env.VITE_NO_ELECTRON === "1";

// ImportableSession mirrors the daemon's ImportableSessionView: one agent
// conversation found on disk that can be imported as a resumable AO session.
export interface ImportableSession {
	provider: string;
	nativeSessionId: string;
	title: string;
	cwd: string;
	branch?: string;
	lastActivity: string;
	messageCount: number;
	sizeBytes: number;
	alreadyImported: boolean;
	// Import verdict from the transcript's content. Trivial conversations are
	// withheld by the daemon and never appear here.
	meaning?: "meaningful" | "ambiguous";
}

export const importableSessionsQueryKey = ["importable-sessions"] as const;

async function fetchImportable(days: number, projectId?: string): Promise<ImportableSession[]> {
	const { data, error } = await apiClient.GET("/api/v1/sessions/importable", {
		params: { query: projectId ? { days, projectId } : { days } },
	});
	if (error) throw new Error(apiErrorMessage(error, "Failed to load importable sessions"));
	return (data?.sessions ?? []) as ImportableSession[];
}

// useImportableSessions lists agent conversations on disk that can be imported.
// A projectId narrows the list to that project's own history. The query is
// disabled in preview (no-Electron) mode where there is no daemon.
export function useImportableSessions(days = 60, enabled = true, projectId?: string) {
	return useQuery({
		queryKey: [...importableSessionsQueryKey, days, projectId ?? "all"],
		queryFn: () => fetchImportable(days, projectId),
		enabled: enabled && !usePreviewData,
		throwOnError: false,
	});
}

export interface ImportSessionInput {
	provider: string;
	nativeSessionId: string;
}

// useImportSession imports one discovered conversation. On success it refreshes
// the workspace list (so the new session appears) and the importable list (so
// the imported row flips to "already imported").
export function useImportSession() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (input: ImportSessionInput) => {
			const { data, error } = await apiClient.POST("/api/v1/sessions/import", { body: input });
			if (error) throw new Error(apiErrorMessage(error, "Import failed"));
			return data;
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
			void queryClient.invalidateQueries({ queryKey: importableSessionsQueryKey });
		},
	});
}


// ImportAllProgress is the running state of a bulk import.
export interface ImportAllProgress {
	done: number;
	total: number;
	imported: number;
	failed: number;
}

async function importOne(input: ImportSessionInput): Promise<void> {
	const { error } = await apiClient.POST("/api/v1/sessions/import", { body: input });
	if (error) throw new Error(apiErrorMessage(error, "Import failed"));
}

// importLanes is how many folders are imported at once. Imports are dominated
// by waiting — scanning, git, starting an agent — so running several at once is
// most of the win, while a cap keeps a big history from opening hundreds of git
// operations and agent processes simultaneously.
const importLanes = 4;

// useImportAllSessions imports every listed conversation in one action, so a
// user arriving with a hundred threads does not have to click a hundred times.
//
// Work is grouped by folder and the groups run concurrently, but a single
// folder is imported one conversation at a time. Creating a git worktree takes
// a repository-wide lock, so two imports racing inside the same repository
// would contend for it and fail for no reason, while separate repositories are
// genuinely independent.
//
// A conversation that fails is counted and stepped over, because one bad
// transcript must not strand the rest of the run.
//
// Nothing is queued server-side. The list is already on the client, and
// importing is idempotent, so a stopped or interrupted run simply resumes where
// it left off the next time.
export function useImportAllSessions() {
	const queryClient = useQueryClient();
	const [progress, setProgress] = useState<ImportAllProgress | null>(null);
	// Running is explicit rather than derived from the counts. A stopped run
	// leaves done short of total by definition, so deriving it left the spinner
	// turning forever and the summary never showed.
	const [running, setRunning] = useState(false);
	const cancelled = useRef(false);

	const stop = useCallback(() => {
		cancelled.current = true;
	}, []);

	const importAll = useCallback(
		async (sessions: ImportableSession[]) => {
			const pending = sessions.filter((session) => !session.alreadyImported);
			if (pending.length === 0) return;

			cancelled.current = false;
			setRunning(true);
			let done = 0;
			let imported = 0;
			let failed = 0;
			setProgress({ done: 0, total: pending.length, imported: 0, failed: 0 });

			// One lane per folder, so imports inside a repository stay ordered
			// while different repositories proceed at the same time.
			const byFolder = new Map<string, ImportableSession[]>();
			for (const session of pending) {
				const folder = session.cwd || "";
				const bucket = byFolder.get(folder);
				if (bucket) bucket.push(session);
				else byFolder.set(folder, [session]);
			}
			const lanes = [...byFolder.values()];
			let nextLane = 0;

			const runLane = async () => {
				for (;;) {
					if (cancelled.current) return;
					const lane = lanes[nextLane++];
					if (!lane) return;
					for (const session of lane) {
						if (cancelled.current) return;
						try {
							await importOne({ provider: session.provider, nativeSessionId: session.nativeSessionId });
							imported += 1;
						} catch {
							// Counted, not surfaced one by one: a run of a hundred
							// cannot stop to explain each failure. The summary
							// reports the total.
							failed += 1;
						}
						done += 1;
						setProgress({ done, total: pending.length, imported, failed });
					}
				}
			};

			try {
				await Promise.all(Array.from({ length: Math.min(importLanes, lanes.length) }, runLane));
			} finally {
				// Whether the run finished or was stopped, it is no longer running.
				// Stopping still leaves a result worth reporting.
				setRunning(false);
			}

			// One refresh at the end. Invalidating per conversation would refetch
			// the whole workspace on every step of a long run.
			void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
			void queryClient.invalidateQueries({ queryKey: importableSessionsQueryKey });
		},
		[queryClient],
	);

	const clear = useCallback(() => setProgress(null), []);

	return { importAll, stop, clear, progress, running };
}
