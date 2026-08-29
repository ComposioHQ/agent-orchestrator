// Standalone shell terminals: shells the user opens by hand from the topbar or
// ⌘T / Ctrl+T, with no agent session behind them. They are deliberately kept out of
// the workspaces query — they are not sessions, never appear on the board, and
// must not invalidate session state when they come and go.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient, apiErrorCode, hasTrustedApiBaseUrl } from "../lib/api-client";
import { mockShellTerminals } from "../lib/mock-data";
import { isWindowsPlatform } from "../lib/platform";
import { terminalShellRequestValue, useTerminalShellStore } from "../stores/terminal-shell-store";

export type ShellTerminal = {
	/** Runtime handle the terminal mux attaches to, exactly like a session pane's. */
	handleId: string;
	projectId?: string;
	/** Agent session this shell is scoped to; absent for standalone shells. */
	sessionId?: string;
	workingDir: string;
	title: string;
	createdAt: string;
};

export const shellTerminalsQueryKey = ["shell-terminals"] as const;
const usePreviewData = import.meta.env.VITE_NO_ELECTRON === "1";

function isLegacyDirectoryTitle(title: string, workingDir: string): boolean {
	const parts = workingDir.split(/[\\/]/).filter(Boolean);
	return parts.at(-1) === title;
}

function toShellTerminal(t: components["schemas"]["ShellTerminalResponse"]): ShellTerminal {
	const title = isLegacyDirectoryTitle(t.title, t.workingDir) ? "Terminal" : t.title;
	return {
		handleId: t.handleId,
		projectId: t.projectId,
		sessionId: t.sessionId,
		workingDir: t.workingDir,
		// Shell tabs used to be named after their initial directory. Normalize
		// those persisted legacy labels so existing tabs adopt the new idle state.
		title: title === "Terminal" ? "Terminal 1" : title,
		createdAt: t.createdAt,
	};
}

// Preview-only shell list. The browser build has no daemon to spawn a PTY, so
// open/close mutate this array instead — keeping the tab strip fully
// interactive (open, select, close) without a backend, which is what the e2e
// suite drives.
let previewShellTerminals: ShellTerminal[] = [...mockShellTerminals];
let previewShellSeq = 0;

async function fetchShellTerminals(): Promise<ShellTerminal[]> {
	if (usePreviewData) {
		return previewShellTerminals;
	}
	if (!hasTrustedApiBaseUrl()) {
		return [];
	}
	const { data, error } = await apiClient.GET("/api/v1/shell-terminals");
	if (error) throw error;
	return (data?.shellTerminals ?? []).map(toShellTerminal);
}

// No refetchInterval: shell terminals only change when this client opens or
// closes one, and both mutations invalidate the query. Polling would spend a
// liveness probe per shell per interval for no new information.
export const shellTerminalsQueryOptions = {
	queryKey: shellTerminalsQueryKey,
	queryFn: fetchShellTerminals,
	retry: 1,
};

export function useShellTerminals() {
	return useQuery(shellTerminalsQueryOptions);
}

export type OpenShellTerminalInput = { projectId?: string; sessionId?: string; shell?: string };

/**
 * Opens a shell in the given project's root (or the daemon data dir when
 * omitted). When sessionId is set the shell is scoped to that session and only
 * appears in its tab strip; otherwise it is a standalone shell on /terminals.
 */
export function useOpenShellTerminal() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({ projectId, sessionId, shell }: OpenShellTerminalInput = {}): Promise<ShellTerminal> => {
			if (usePreviewData) {
				previewShellSeq += 1;
				const shell: ShellTerminal = {
					handleId: `shellterm-preview-${previewShellSeq}`,
					projectId,
					sessionId,
					workingDir: `/Users/demo/Projects/${projectId ?? "ao"}`,
					title: `Terminal ${previewShellSeq}`,
					createdAt: new Date().toISOString(),
				};
				previewShellTerminals = [...previewShellTerminals, shell];
				return shell;
			}
			const body: OpenShellTerminalInput = {};
			if (projectId) body.projectId = projectId;
			if (sessionId) body.sessionId = sessionId;
			if (isWindowsPlatform()) {
				await useTerminalShellStore.getState().load();
				body.shell = shell ?? terminalShellRequestValue(useTerminalShellStore.getState().preference);
			}
			const { data, error } = await apiClient.POST("/api/v1/shell-terminals", { body });
			if (error) throw error;
			if (!data) throw new Error("Daemon returned no shell terminal");
			return toShellTerminal(data.shellTerminal);
		},
		onSuccess: (shell) => {
			// The POST already returned the authoritative terminal. Publish it to the
			// shared list immediately so its tab can render and receive focus without
			// waiting for a second daemon round trip. The background refetch still
			// reconciles concurrent changes from another window.
			queryClient.setQueryData<ShellTerminal[]>(shellTerminalsQueryKey, (current) => {
				if (current?.some((candidate) => candidate.handleId === shell.handleId)) return current;
				return [...(current ?? []), shell];
			});
			void queryClient.invalidateQueries({ queryKey: shellTerminalsQueryKey });
		},
		// Without this, a failed open (worktree gone, no shell resolvable, daemon
		// busy) leaves the "+" button looking like it silently did nothing.
		onError: (error) => {
			console.error("Failed to open shell terminal:", error);
			if (isWindowsPlatform() && apiErrorCode(error) === "SHELL_TERMINAL_SHELL_UNAVAILABLE") {
				void useTerminalShellStore.getState().setPreference({ kind: "auto" });
			}
		},
	});
}

/** Closes a shell and destroys its PTY. */
export function useCloseShellTerminal() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (handleId: string): Promise<void> => {
			if (usePreviewData) {
				previewShellTerminals = previewShellTerminals.filter((s) => s.handleId !== handleId);
				return;
			}
			const { error } = await apiClient.DELETE("/api/v1/shell-terminals/{handleId}", {
				params: { path: { handleId } },
			});
			if (error) throw error;
		},
		onMutate: async (handleId) => {
			const previous = queryClient.getQueryData<ShellTerminal[]>(shellTerminalsQueryKey);
			const removeClosedShell = () => {
				queryClient.setQueryData<ShellTerminal[]>(shellTerminalsQueryKey, (current) =>
					current?.filter((shell) => shell.handleId !== handleId),
				);
			};
			// Remove the pill synchronously. Waiting for cancellation first leaves the
			// closed tab visible for the duration of an in-flight list request.
			removeClosedShell();
			await queryClient.cancelQueries({ queryKey: shellTerminalsQueryKey });
			// A request that resolved while cancellation was being scheduled may have
			// restored its stale snapshot; make the optimistic state authoritative.
			removeClosedShell();
			return { previous };
		},
		onError: (error, _handleId, context) => {
			// A 404 means the daemon has already removed the shell, so restoring its
			// stale tab would be misleading. Other failures put the tab back so the
			// user can retry instead of losing access to a still-live PTY.
			if (apiErrorCode(error) !== "SHELL_TERMINAL_NOT_FOUND" && context?.previous) {
				queryClient.setQueryData(shellTerminalsQueryKey, context.previous);
			}
		},
		// Settled, not success: a close that 404s means the daemon already lost
		// the shell, and the stale tab still needs to disappear.
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: shellTerminalsQueryKey });
		},
	});
}

export type RenameShellTerminalInput = { handleId: string; title: string };

/** Renames a shell terminal's tab. The new title persists on the daemon. */
export function useRenameShellTerminal() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({ handleId, title }: RenameShellTerminalInput): Promise<ShellTerminal> => {
			if (usePreviewData) {
				previewShellTerminals = previewShellTerminals.map((s) => (s.handleId === handleId ? { ...s, title } : s));
				const shell = previewShellTerminals.find((s) => s.handleId === handleId);
				if (!shell) throw new Error("No such shell terminal");
				return shell;
			}
			const { data, error } = await apiClient.PATCH("/api/v1/shell-terminals/{handleId}", {
				params: { path: { handleId } },
				body: { title },
			});
			if (error) throw error;
			if (!data) throw new Error("Daemon returned no shell terminal");
			return toShellTerminal(data.shellTerminal);
		},
		onMutate: async ({ handleId, title }) => {
			await queryClient.cancelQueries({ queryKey: shellTerminalsQueryKey });
			const previous = queryClient.getQueryData<ShellTerminal[]>(shellTerminalsQueryKey);
			queryClient.setQueryData<ShellTerminal[]>(shellTerminalsQueryKey, (current) =>
				current?.map((shell) => (shell.handleId === handleId ? { ...shell, title } : shell)),
			);
			return { previous };
		},
		onError: (_error, _input, context) => {
			if (context?.previous) queryClient.setQueryData(shellTerminalsQueryKey, context.previous);
		},
		onSuccess: (shell) => {
			queryClient.setQueryData<ShellTerminal[]>(shellTerminalsQueryKey, (current) =>
				current?.map((candidate) => (candidate.handleId === shell.handleId ? shell : candidate)),
			);
			void queryClient.invalidateQueries({ queryKey: shellTerminalsQueryKey });
		},
	});
}
