import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { dialog, ipcMain } from "electron";
import { cloudAvailability, getCloudAccessToken } from "./cloud-auth";
import type { CloudCredentialStatus } from "../shared/cloud-credential";

const execFile = promisify(execFileCallback);
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLAUDE_PROVIDER = "claude-code" as const;

interface RedactedProviderConnection {
	provider: string;
	config?: { credentialType?: "oauth_token" | "api_key" | "access_token" };
	updatedAt?: string;
}

interface CredentialDependencies {
	readClaudeKeychain: () => Promise<Buffer>;
	confirmImport: () => Promise<boolean>;
	accessToken: () => Promise<string>;
	apiBaseUrl: () => string;
	fetch: typeof fetch;
}

export async function readClaudeCredentialFromKeychain(): Promise<Buffer> {
	if (process.platform !== "darwin") throw new Error("Claude Code Keychain import is available on macOS only.");
	try {
		// execFile never invokes a shell. The credential is stdout, not an argv or
		// environment value, and the child-process error is deliberately replaced.
		const result = await execFile("/usr/bin/security", [
			"find-generic-password",
			"-s",
			CLAUDE_KEYCHAIN_SERVICE,
			"-w",
		], { encoding: "buffer", maxBuffer: 1024 * 1024 });
		return Buffer.from(result.stdout);
	} catch {
		throw new Error("Claude Code credentials were not found in Keychain.");
	}
}

async function nativeImportConsent(): Promise<boolean> {
	const result = await dialog.showMessageBox({
		type: "warning",
		title: "Use Claude Code in AO Cloud?",
		message: "Import your Claude Code sign-in from Keychain?",
		detail: "AO will encrypt it for your selected Cloud organization and only materialize it inside your sandbox while Claude Code is running.",
		buttons: ["Cancel", "Import securely"],
		defaultId: 0,
		cancelId: 0,
		noLink: true,
	});
	return result.response === 1;
}

function validateClaudeCredential(secret: Buffer): void {
	if (secret.length === 0 || secret.length > 65536) throw new Error("Claude Code Keychain credential is invalid.");
	try {
		const parsed = JSON.parse(secret.toString("utf8")) as { claudeAiOauth?: { accessToken?: unknown } };
		if (typeof parsed.claudeAiOauth?.accessToken !== "string" || parsed.claudeAiOauth.accessToken.length === 0) {
			throw new Error("invalid");
		}
	} catch {
		throw new Error("Claude Code Keychain credential is invalid.");
	}
}

function orgRoute(baseUrl: string, orgId: string, suffix: string): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	if (!normalized || !orgId.trim()) throw new Error("AO Cloud organization is required.");
	return `${normalized}/api/cloud/v1/orgs/${encodeURIComponent(orgId.trim())}${suffix}`;
}

async function request(deps: CredentialDependencies, orgId: string, suffix: string, init: RequestInit): Promise<Response> {
	const token = await deps.accessToken();
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${token}`);
	headers.set("Accept", "application/json");
	const response = await deps.fetch(orgRoute(deps.apiBaseUrl(), orgId, suffix), { ...init, headers });
	if (!response.ok) throw new Error(`AO Cloud credential request failed (${response.status}).`);
	return response;
}

export function createCloudCredentialCustody(overrides: Partial<CredentialDependencies> = {}) {
	const deps: CredentialDependencies = {
		readClaudeKeychain: readClaudeCredentialFromKeychain,
		confirmImport: nativeImportConsent,
		accessToken: getCloudAccessToken,
		apiBaseUrl: () => cloudAvailability().apiBaseUrl,
		fetch: globalThis.fetch,
		...overrides,
	};

	return {
		async status(orgId: string): Promise<CloudCredentialStatus> {
			const response = await request(deps, orgId, "/provider-connections", { method: "GET", cache: "no-store" });
			const payload = (await response.json()) as { providerConnections?: RedactedProviderConnection[] };
			const connection = payload.providerConnections?.find((item) => item.provider === CLAUDE_PROVIDER);
			return connection
				? { connected: true, provider: CLAUDE_PROVIDER, credentialType: connection.config?.credentialType, updatedAt: connection.updatedAt }
				: { connected: false, provider: CLAUDE_PROVIDER };
		},

		async importClaude(orgId: string): Promise<CloudCredentialStatus> {
			// Authenticate before prompting for Keychain access. A signed-out or
			// disabled Cloud account must never cause an unnecessary OS secret read.
			await deps.accessToken();
			if (!(await deps.confirmImport())) throw new Error("Claude Code credential import was cancelled.");
			const secret = await deps.readClaudeKeychain();
			try {
				validateClaudeCredential(secret);
				const response = await request(deps, orgId, "/provider-connections/agents/claude-code", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ credentialType: "oauth_token", secret: secret.toString("utf8") }),
				});
				const payload = (await response.json()) as { providerConnection: RedactedProviderConnection };
				return {
					connected: true,
					provider: CLAUDE_PROVIDER,
					credentialType: payload.providerConnection.config?.credentialType,
					updatedAt: payload.providerConnection.updatedAt,
				};
			} finally {
				secret.fill(0);
			}
		},

		async remove(orgId: string): Promise<void> {
			await request(deps, orgId, "/provider-connections/agents/claude-code", { method: "DELETE" });
		},
	};
}

export function installCloudCredentialIPC(): void {
	const custody = createCloudCredentialCustody();
	ipcMain.handle("cloudCredentials:status", (_event, orgId: string) => custody.status(orgId));
	ipcMain.handle("cloudCredentials:importClaude", (_event, orgId: string) => custody.importClaude(orgId));
	ipcMain.handle("cloudCredentials:deleteClaude", (_event, orgId: string) => custody.remove(orgId));
}
