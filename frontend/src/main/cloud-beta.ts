import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
	CloudBetaOverview,
	CloudHarness,
	CloudHarnessConnection,
	CloudProject,
	CloudSessionSummary,
	ConnectCloudHarnessResult,
	CreateCloudProjectInput,
	CreateCloudSessionInput,
} from "../shared/cloud-beta";

const execFileAsync = promisify(execFile);
const DEFAULT_CLOUD_API_BASE_URL = "https://staging-api.aoagents.dev";

interface CloudAccountResponse {
	organizations: Array<{ id: string; displayName: string; role: string }>;
}

interface ProviderConnection {
	provider: string;
	validationState?: "pending" | "valid" | "invalid";
	config?: { credentialType?: string };
}

interface LocalCredential {
	secret: string;
	credentialType: "oauth_token" | "api_key" | "access_token";
	source: ConnectCloudHarnessResult["source"];
}

export function cloudBetaEnabled(): boolean {
	return import.meta.env.VITE_AO_CLOUD_BETA === "true";
}

export function cloudApiBaseUrl(): string {
	return (
		import.meta.env.VITE_AO_CLOUD_API_BASE_URL?.trim() ||
		process.env.AO_CLOUD_API_BASE_URL?.trim() ||
		DEFAULT_CLOUD_API_BASE_URL
	).replace(/\/+$/, "");
}

async function cloudRequest<T>(
	accessToken: string,
	pathname: string,
	init: RequestInit = {},
): Promise<T> {
	const headers = new Headers(init.headers);
	headers.set("Accept", "application/json");
	headers.set("Authorization", `Bearer ${accessToken}`);
	if (init.body) headers.set("Content-Type", "application/json");
	const response = await fetch(`${cloudApiBaseUrl()}${pathname}`, { ...init, headers });
	if (!response.ok) {
		let message = `AO Cloud request failed (${response.status}).`;
		try {
			const body = (await response.json()) as { message?: string; requestId?: string };
			if (body.message) message = body.message;
			if (body.requestId) message += ` Request ${body.requestId}.`;
		} catch {
			// Preserve the status-only message when the upstream did not return JSON.
		}
		throw new Error(message);
	}
	if (response.status === 204) return undefined as T;
	return response.json() as Promise<T>;
}

export async function loadCloudBetaOverview(accessToken: string): Promise<CloudBetaOverview> {
	const account = await cloudRequest<CloudAccountResponse>(accessToken, "/api/cloud/v1/me");
	const organization = account.organizations[0];
	if (!organization) throw new Error("Your AO Cloud account does not belong to an organization yet.");
	const orgPath = `/api/cloud/v1/orgs/${encodeURIComponent(organization.id)}`;
	const [projectPage, sessionPage, providerPage] = await Promise.all([
		cloudRequest<{ items: CloudProject[] }>(accessToken, `${orgPath}/projects?limit=100`),
		cloudRequest<{ items: CloudSessionSummary[] }>(accessToken, `${orgPath}/sessions?limit=100`),
		cloudRequest<{ providerConnections: ProviderConnection[] }>(accessToken, "/api/cloud/v1/me/providers"),
	]);
	const harnesses: CloudHarnessConnection[] = (["claude-code", "codex"] as const).map((harness) => {
		const connection = providerPage.providerConnections.find((item) => item.provider === harness);
		return {
			harness,
			connected: connection?.validationState === "valid",
			validationState: connection?.validationState,
			credentialType: connection?.config?.credentialType,
		};
	});
	return {
		apiBaseUrl: cloudApiBaseUrl(),
		organization,
		projects: projectPage.items.map((project) => ({ ...project, executionLocation: "cloud" })),
		sessions: sessionPage.items,
		harnesses,
	};
}

export async function createCloudProject(
	accessToken: string,
	orgId: string,
	input: CreateCloudProjectInput,
): Promise<CloudProject> {
	const response = await cloudRequest<{ project: CloudProject }>(
		accessToken,
		`/api/cloud/v1/orgs/${encodeURIComponent(orgId)}/projects`,
		{
			method: "POST",
			headers: { "Idempotency-Key": crypto.randomUUID() },
			body: JSON.stringify({ ...input, config: {} }),
		},
	);
	return { ...response.project, executionLocation: "cloud" };
}

export async function createCloudSession(
	accessToken: string,
	input: CreateCloudSessionInput,
): Promise<CloudSessionSummary> {
	const response = await cloudRequest<{ session: CloudSessionSummary }>(
		accessToken,
		`/api/cloud/v1/orgs/${encodeURIComponent(input.orgId)}/sessions`,
		{
			method: "POST",
			headers: { "Idempotency-Key": crypto.randomUUID() },
			body: JSON.stringify({
				projectId: input.projectId,
				kind: input.kind,
				harness: input.harness,
				displayName: input.displayName,
				prompt: input.prompt,
				mode: "trusted",
				deniedCommands: [],
			}),
		},
	);
	return response.session;
}

function stringAt(value: unknown, keys: string[]): string | null {
	let current: unknown = value;
	for (const key of keys) {
		if (!current || typeof current !== "object") return null;
		current = (current as Record<string, unknown>)[key];
	}
	return typeof current === "string" && current.trim() ? current.trim() : null;
}

async function readJSON(filePath: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(filePath, "utf8")) as unknown;
	} catch {
		return null;
	}
}

async function localClaudeCredential(): Promise<LocalCredential | null> {
	if (process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
		return { secret: process.env.CLAUDE_CODE_OAUTH_TOKEN.trim(), credentialType: "oauth_token", source: "environment" };
	}
	if (process.env.ANTHROPIC_API_KEY?.trim()) {
		return { secret: process.env.ANTHROPIC_API_KEY.trim(), credentialType: "api_key", source: "environment" };
	}
	if (process.platform === "darwin") {
		try {
			const { stdout } = await execFileAsync(
				"security",
				["find-generic-password", "-s", "Claude Code-credentials", "-w"],
				{ timeout: 5_000, maxBuffer: 512 * 1024 },
			);
			const stored = JSON.parse(stdout) as unknown;
			const token = stringAt(stored, ["claudeAiOauth", "accessToken"]);
			if (token) return { secret: token, credentialType: "oauth_token", source: "claude-keychain" };
		} catch {
			// Continue to Claude's file-backed store used on other platforms/builds.
		}
	}
	const stored = await readJSON(path.join(os.homedir(), ".claude", ".credentials.json"));
	const token = stringAt(stored, ["claudeAiOauth", "accessToken"]);
	return token ? { secret: token, credentialType: "oauth_token", source: "claude-credentials" } : null;
}

async function localCodexCredential(): Promise<LocalCredential | null> {
	if (process.env.CODEX_ACCESS_TOKEN?.trim()) {
		return { secret: process.env.CODEX_ACCESS_TOKEN.trim(), credentialType: "access_token", source: "environment" };
	}
	if (process.env.OPENAI_API_KEY?.trim()) {
		return { secret: process.env.OPENAI_API_KEY.trim(), credentialType: "api_key", source: "environment" };
	}
	const stored = await readJSON(path.join(process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"), "auth.json"));
	const token =
		stringAt(stored, ["tokens", "access_token"]) ||
		stringAt(stored, ["access_token"]);
	return token ? { secret: token, credentialType: "access_token", source: "codex-auth" } : null;
}

export async function connectLocalHarness(
	accessToken: string,
	harness: CloudHarness,
): Promise<ConnectCloudHarnessResult> {
	const credential = harness === "claude-code" ? await localClaudeCredential() : await localCodexCredential();
	if (!credential) {
		throw new Error(
			harness === "claude-code"
				? "No local Claude Code subscription login was found. Run `claude` and sign in once, then try again."
				: "No local Codex subscription login was found. Run `codex login`, then try again.",
		);
	}
	await cloudRequest(
		accessToken,
		`/api/cloud/v1/me/providers/${encodeURIComponent(harness)}`,
		{
			method: "PUT",
			body: JSON.stringify({ credentialType: credential.credentialType, secret: credential.secret }),
		},
	);
	return { harness, connected: true, source: credential.source };
}
