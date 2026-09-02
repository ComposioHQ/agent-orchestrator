import type { components } from "../../api/schema";
import { apiErrorMessage } from "../lib/api-client";
import { clientFor } from "../lib/host-clients";
import { refKey, type Ref } from "../lib/hosts";
import {
	isChangedWorkspaceFile,
	workspaceSessionRef,
	type WorkspaceFileSummary,
	type WorkspaceSessionRef,
} from "./useSessionWorkspaceFiles";

export type WorkspaceTreeEntry = components["schemas"]["WorkspaceTreeEntry"];
export type WorkspaceTreeResponse = components["schemas"]["ListWorkspaceTreeResponse"];

export const sessionWorkspaceTreeQueryKey = (session: WorkspaceSessionRef, dir: string) =>
	["session-workspace-tree", refKey(workspaceSessionRef(session)), dir] as const;

async function fetchSessionWorkspaceTree(session: Ref, dir: string, errorMessage: string): Promise<WorkspaceTreeResponse> {
	const { data, error } = await clientFor(session.host).GET("/api/v1/sessions/{sessionId}/workspace/tree", {
		params: { path: { sessionId: session.id }, query: dir ? { path: dir } : {} },
	});
	if (error) throw new Error(apiErrorMessage(error, errorMessage));
	return (data ?? { sessionId: session.id, path: dir, entries: [], truncated: false }) as WorkspaceTreeResponse;
}

// dir is a directory path relative to the workspace root, "" for the root.
// Unlike the changed-files list this isn't polled: the daemon only pushes a
// coarse "something changed" signal (see workspace-file-events.ts), which
// invalidates every mounted directory query by key prefix — a directory the
// user isn't currently looking at just stays stale until they revisit it.
export function sessionWorkspaceTreeQueryOptions(
	session: WorkspaceSessionRef,
	dir: string,
	errorMessage = "Unable to load workspace tree",
) {
	const ref = workspaceSessionRef(session);
	return {
		queryKey: sessionWorkspaceTreeQueryKey(ref, dir),
		queryFn: () => fetchSessionWorkspaceTree(ref, dir, errorMessage),
	};
}

export type TreeNode = {
	name: string;
	path: string;
	type: "file" | "dir";
	status?: WorkspaceTreeEntry["status"];
	hasChanges?: boolean;
	binary?: boolean;
	children?: TreeNode[];
};

// Synthesizes a full nested tree from the already-fetched, already-small
// changed-files list — this is the entire data source for "changed only"
// mode. It intentionally does not go through the lazy /workspace/tree
// endpoint: the changed-files list is already warm and small, and a lazy
// per-directory fetch would only add round trips for data already in hand.
export function buildChangedOnlyTree(files: WorkspaceFileSummary[]): TreeNode[] {
	const changed = files.filter(isChangedWorkspaceFile);
	const root: TreeNode[] = [];
	const dirs = new Map<string, TreeNode>();

	const ensureDir = (path: string): TreeNode => {
		const existing = dirs.get(path);
		if (existing) return existing;
		const segments = path.split("/");
		const name = segments[segments.length - 1];
		const node: TreeNode = { name, path, type: "dir", hasChanges: true, children: [] };
		dirs.set(path, node);
		const parentPath = segments.slice(0, -1).join("/");
		if (parentPath) ensureDir(parentPath).children!.push(node);
		else root.push(node);
		return node;
	};

	for (const file of changed) {
		const segments = file.path.split("/");
		const name = segments[segments.length - 1];
		const parentPath = segments.slice(0, -1).join("/");
		const fileNode: TreeNode = { name, path: file.path, type: "file", status: file.status, binary: file.binary };
		if (parentPath) ensureDir(parentPath).children!.push(fileNode);
		else root.push(fileNode);
	}

	const sortTree = (nodes: TreeNode[]) => {
		nodes.sort((a, b) => {
			if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
		for (const node of nodes) if (node.children) sortTree(node.children);
	};
	sortTree(root);
	return root;
}
