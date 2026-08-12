import { Client } from "@xhayper/discord-rpc";
import createClient from "openapi-fetch";
import type { paths } from "../api/schema";
import {
	DISCORD_CLIENT_ID,
	RPC_LARGE_IMAGE_KEY,
	RPC_LARGE_IMAGE_TEXT,
	RPC_PRESENCE_REFRESH_INTERVAL_MS,
	type RpcConnectionState,
	type RpcSettings,
	type RpcStatus,
} from "../shared/rpc";

type SessionStatus =
	| "working"
	| "pr_open"
	| "draft"
	| "ci_failed"
	| "review_pending"
	| "changes_requested"
	| "approved"
	| "mergeable"
	| "merged"
	| "needs_input"
	| "exited"
	| "idle"
	| "terminated"
	| "no_signal";

const STATUS_PRIORITY: { status: SessionStatus; label: string }[] = [
	{ status: "needs_input", label: "Waiting on you" },
	{ status: "ci_failed", label: "Fixing CI" },
	{ status: "changes_requested", label: "Addressing review" },
	{ status: "merge_conflict" as SessionStatus, label: "Resolving conflicts" },
	{ status: "draft", label: "Drafting PR" },
	{ status: "review_pending", label: "In review" },
	{ status: "pr_open", label: "In review" },
	{ status: "mergeable", label: "Ready to merge" },
	{ status: "approved", label: "Ready to merge" },
	{ status: "working", label: "Working" },
	{ status: "no_signal", label: "Idle" },
	{ status: "idle", label: "Idle" },
];

const EXCLUDED_STATUSES: SessionStatus[] = ["exited", "terminated", "merged"];

interface ActivityPayload {
	details: string;
	state: string;
	startTimestamp: number;
	largeImageKey: string;
	largeImageText: string;
	buttons?: { label: string; url: string }[];
}

let client: Client | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let apiClient: ReturnType<typeof createClient<paths>> | null = null;
let connectionState: RpcConnectionState = "disconnected";
let statusListeners: ((status: RpcStatus) => void)[] = [];

function makeApiClient(port: number): ReturnType<typeof createClient<paths>> {
	return createClient<paths>({ baseUrl: `http://127.0.0.1:${port}` });
}

export function setDaemonPort(port: number): void {
	apiClient = makeApiClient(port);
}

function broadcastStatus(): void {
	const status: RpcStatus = { state: connectionState };
	for (const listener of statusListeners) {
		listener(status);
	}
}

export function onRpcStatus(listener: (status: RpcStatus) => void): () => void {
	statusListeners.push(listener);
	listener({ state: connectionState });
	return () => {
		statusListeners = statusListeners.filter((l) => l !== listener);
	};
}

export function getRpcStatus(): RpcStatus {
	return { state: connectionState };
}

export async function startDiscordRpc(): Promise<void> {
	if (client) return;
	client = new Client({ clientId: DISCORD_CLIENT_ID });
	connectionState = "connecting";
	broadcastStatus();
	try {
		await client.login();
		connectionState = "connected";
	} catch {
		connectionState = "disconnected";
	}
	broadcastStatus();
	refreshTimer = setInterval(() => {
		void refreshPresence();
	}, RPC_PRESENCE_REFRESH_INTERVAL_MS);
}

export async function setRpcSettings(_settings: RpcSettings): Promise<void> {
	void refreshPresence();
}

export function pickRepresentativeStatus(sessions: { status: string; isTerminated: boolean }[]): { label: string; count: number } | null {
	const active = sessions.filter((s) => !s.isTerminated && !EXCLUDED_STATUSES.includes(s.status as SessionStatus));
	if (active.length === 0) return null;
	for (const entry of STATUS_PRIORITY) {
		const matching = active.filter((s) => s.status === entry.status);
		if (matching.length > 0) {
			return { label: entry.label, count: active.length };
		}
	}
	return { label: "Idle", count: active.length };
}

export function buildActivityPayload(
	sessions: { status: string; isTerminated: boolean; createdAt?: string }[],
	projects: { repo?: string }[],
): ActivityPayload | null {
	const rep = pickRepresentativeStatus(sessions);
	if (!rep) return null;
	const workingSessions = sessions.filter(
		(s) => !s.isTerminated && s.status === "working" && s.createdAt,
	);
	const oldestWorking = workingSessions
		.map((s) => Date.parse(s.createdAt!))
		.filter((t): t is number => !Number.isNaN(t))
		.sort((a, b) => a - b)[0];
	const repoUrl = projects.find((p) => p.repo && p.repo.startsWith("http"))?.repo;
	const buttons = repoUrl ? [{ label: "View on GitHub", url: repoUrl }] : undefined;
	return {
		details: `Orchestrating ${rep.count} ${rep.count === 1 ? "agent" : "agents"}`,
		state: rep.label,
		startTimestamp: oldestWorking ?? Date.now(),
		largeImageKey: RPC_LARGE_IMAGE_KEY,
		largeImageText: RPC_LARGE_IMAGE_TEXT,
		buttons,
	};
}

async function refreshPresence(): Promise<void> {
	if (!client || !apiClient || connectionState !== "connected") return;
	const { data: sessionsResp, error: sessionsErr } = await apiClient.GET("/api/v1/sessions", {});
	const { data: projectsResp, error: projectsErr } = await apiClient.GET("/api/v1/projects", {});
	if (sessionsErr || projectsErr || !sessionsResp || !projectsResp) return;
	const sessions = (sessionsResp as { sessions?: { status: string; isTerminated: boolean; createdAt?: string }[] }).sessions ?? [];
	const projects = (projectsResp as { projects?: { repo?: string }[] }).projects ?? [];
	const payload = buildActivityPayload(sessions, projects);
	if (!payload) {
		await clearActivity();
		return;
	}
	try {
		await client.request("SET_ACTIVITY", {
			activity: {
				details: payload.details,
				state: payload.state,
				timestamps: { start: payload.startTimestamp },
				assets: {
					large_image: payload.largeImageKey,
					large_text: payload.largeImageText,
				},
				buttons: payload.buttons,
			},
		});
	} catch {
		connectionState = "disconnected";
		broadcastStatus();
	}
}

async function clearActivity(): Promise<void> {
	if (!client || connectionState !== "connected") return;
	try {
		await client.request("SET_ACTIVITY", { activity: null });
	} catch {
		connectionState = "disconnected";
		broadcastStatus();
	}
}

export async function disposeDiscordRpc(): Promise<void> {
	if (refreshTimer) {
		clearInterval(refreshTimer);
		refreshTimer = null;
	}
	await clearActivity();
	if (client) {
		try {
			await client.destroy();
		} catch {
		}
		client = null;
	}
	connectionState = "disconnected";
	broadcastStatus();
}
