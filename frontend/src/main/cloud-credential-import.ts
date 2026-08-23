import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { dialog } from "electron";

const execFile = promisify(execFileCallback);

export const CLAUDE_CODE_PROVIDER = "claude-code" as const;
export const CLOUD_CREDENTIAL_IMPORT_CHANNEL = "cloudCredentials:importClaudeCode" as const;

const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const MAX_CREDENTIAL_BYTES = 64 * 1024;

export interface CloudCredentialImportMetadata {
	credentialId: string;
	provider: typeof CLAUDE_CODE_PROVIDER;
	version: number;
	updatedAt: string;
}

export interface CloudCredentialUpload {
	provider: typeof CLAUDE_CODE_PROVIDER;
	secret: Uint8Array;
}

export interface CloudCredentialImportDependencies {
	authorize: () => Promise<void>;
	confirmImport: () => Promise<boolean>;
	readCredential: () => Promise<Buffer>;
	uploadCredential: (upload: CloudCredentialUpload) => Promise<CloudCredentialImportMetadata>;
}

// Reads from macOS Keychain without putting secret material in argv, env, a
// shell, a file, or a log. The caller owns and must zero the returned buffer.
export async function readClaudeCodeCredentialFromKeychain(): Promise<Buffer> {
	if (process.platform !== "darwin") {
		throw new Error("Claude Code Keychain import is available on macOS only.");
	}
	try {
		const result = await execFile(
			"/usr/bin/security",
			["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
			{ encoding: "buffer", maxBuffer: MAX_CREDENTIAL_BYTES + 2 },
		);
		return result.stdout;
	} catch {
		// Child-process errors may include stdout. Never reflect them.
		throw new Error("Claude Code credentials were not found in Keychain.");
	}
}

export async function requestClaudeCodeImportConsent(): Promise<boolean> {
	const result = await dialog.showMessageBox({
		type: "warning",
		title: "Use Claude Code in AO Cloud?",
		message: "Import your Claude Code sign-in from Keychain?",
		detail:
			"AO will envelope-encrypt this credential for your selected Cloud organization. It is loaded only by your remote Claude Code harness and then purged.",
		buttons: ["Cancel", "Import securely"],
		defaultId: 0,
		cancelId: 0,
		noLink: true,
	});
	return result.response === 1;
}

export function createCloudCredentialImporter(
	overrides: Partial<CloudCredentialImportDependencies> &
		Pick<CloudCredentialImportDependencies, "authorize" | "uploadCredential">,
) {
	const dependencies: CloudCredentialImportDependencies = {
		confirmImport: requestClaudeCodeImportConsent,
		readCredential: readClaudeCodeCredentialFromKeychain,
		...overrides,
	};

	return {
		async importClaudeCode(): Promise<CloudCredentialImportMetadata> {
			// Authenticate before consent or Keychain access. A signed-out or
			// disabled account must never trigger an OS credential prompt.
			await dependencies.authorize();
			if (!(await dependencies.confirmImport())) {
				throw new Error("Claude Code credential import was cancelled.");
			}
			const source = await dependencies.readCredential();
			try {
				const secret = withoutSecurityToolNewline(source);
				validateClaudeCodeCredential(secret);
				let uploaded: CloudCredentialImportMetadata;
				try {
					uploaded = await dependencies.uploadCredential({ provider: CLAUDE_CODE_PROVIDER, secret });
				} catch {
					// Transport errors can contain request bodies. Replace them.
					throw new Error("Claude Code credential import failed.");
				}
				if (
					uploaded.provider !== CLAUDE_CODE_PROVIDER ||
					typeof uploaded.credentialId !== "string" ||
					!uploaded.credentialId ||
					!Number.isSafeInteger(uploaded.version) ||
					uploaded.version < 1 ||
					typeof uploaded.updatedAt !== "string"
				) {
					throw new Error("AO Cloud returned invalid credential metadata.");
				}
				// Rebuild the result so an adapter cannot smuggle secret fields to IPC.
				return {
					credentialId: uploaded.credentialId,
					provider: CLAUDE_CODE_PROVIDER,
					version: uploaded.version,
					updatedAt: uploaded.updatedAt,
				};
			} finally {
				source.fill(0);
			}
		},
	};
}

function withoutSecurityToolNewline(source: Buffer): Uint8Array {
	let end = source.length;
	if (end > 0 && source[end - 1] === 0x0a) end--;
	if (end > 0 && source[end - 1] === 0x0d) end--;
	return source.subarray(0, end);
}

function validateClaudeCodeCredential(secret: Uint8Array): void {
	if (secret.byteLength === 0 || secret.byteLength > MAX_CREDENTIAL_BYTES) {
		throw new Error("Claude Code Keychain credential is invalid.");
	}
	const buffer = Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength);
	// Full schema validation happens in the vault before encryption. These
	// constant byte markers reject an obviously wrong Keychain item without
	// creating an immutable JavaScript string containing the secret.
	if (
		buffer[0] !== 0x7b ||
		buffer[buffer.length - 1] !== 0x7d ||
		buffer.indexOf(Buffer.from('"claudeAiOauth"')) < 0 ||
		buffer.indexOf(Buffer.from('"accessToken"')) < 0
	) {
		throw new Error("Claude Code Keychain credential is invalid.");
	}
}

