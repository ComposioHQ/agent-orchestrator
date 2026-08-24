// AO Cloud identity and credential custody (Electron main only).
//
// Sign-in is Google OpenID Connect with PKCE over an RFC 8252 loopback
// redirect: AO opens the system browser, receives the authorization code on an
// ephemeral 127.0.0.1 listener it owns for the duration of the flow, exchanges
// it with Google for an ID token, and hands that ID token to the AO control
// plane (POST /api/cloud/v1/auth/google). Google establishes identity only —
// the control plane issues the short-lived AO access token and the rotating
// opaque refresh token (docs/cloud-control-plane.md).
//
// Custody rules, all load-bearing:
//   - Tokens live only under ~/.ao (AGENTS.md hard rule), encrypted with
//     Electron safeStorage, mode 0600. When the OS offers no real protection we
//     keep the session process-local rather than writing a rotating refresh
//     token as plaintext.
//   - The renderer never receives or stores either token. Authenticated cloud
//     requests run in main behind purpose-specific IPC methods.
//   - Refresh is single-flight per data dir and guarded by a generation counter,
//     so a sign-out or a new sign-in that races an in-flight refresh cannot have
//     the stale result written back over it.

import { app, dialog, ipcMain, safeStorage, shell } from "electron";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
	createCloudClient,
	type CloudTokenSet,
	type CurrentAccount,
} from "../../../packages/cloud-client/src/index";
import type { CloudAccount, CloudAvailability, CloudOrganization } from "../shared/cloud-account";
import { cloudDesktopConfigured, cloudEarlyAccessEnabled } from "../shared/cloud-feature";
import { installCloudProjectIPC } from "./cloud-projects";

const CLOUD_API_URL =
	import.meta.env.VITE_AO_CLOUD_API_URL?.trim().replace(/\/+$/, "") ||
	process.env.AO_CLOUD_API_URL?.trim().replace(/\/+$/, "") ||
	(process.env.VITEST ? "https://cloud.example" : "");
const GOOGLE_CLIENT_ID =
	import.meta.env.VITE_AO_CLOUD_GOOGLE_CLIENT_ID?.trim() ||
	process.env.AO_CLOUD_GOOGLE_CLIENT_ID?.trim() ||
	(process.env.VITEST ? "client_test" : "");
// Google still requires the (non-secret, per RFC 8252) client_secret on the
// token endpoint for "Desktop app" clients created before the PKCE-only option.
const GOOGLE_CLIENT_SECRET = process.env.AO_CLOUD_GOOGLE_CLIENT_SECRET?.trim() || "";
const ENVIRONMENT_FLAGS = [import.meta.env.VITE_AO_CLOUD_ENABLED, process.env.AO_CLOUD_ENABLED];
const CLOUD_CONFIGURED = cloudDesktopConfigured({ apiUrl: CLOUD_API_URL, googleClientId: GOOGLE_CLIENT_ID });

const AUTH_STORE_FILE = "cloud-auth.bin";
const LEGACY_SESSION_FILE = "cloud-session.json";
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
/** Refresh this far before the stated expiry so an in-flight request never 401s. */
const EXPIRY_SKEW_MS = 60_000;

let cloudPreferenceEnabled = false;

interface StoredSession {
	authProvider: "google";
	user: CloudAccount["user"];
	organizations: CloudOrganization[];
	storedAt: string;
	accessToken: string;
	refreshToken: string;
	expiresAt: string;
}

interface AuthStore {
	session: StoredSession | null;
}

const emptyStore = (): AuthStore => ({ session: null });
const memoryStores = new Map<string, AuthStore>();
const refreshes = new Map<string, Promise<StoredSession | null>>();
const authGenerations = new Map<string, number>();
const authMutations = new Map<string, Promise<void>>();

/** The build can reach a control plane at all (URL + Google client configured). */
export function cloudDesktopAvailable(): boolean {
	return CLOUD_CONFIGURED;
}

/** Configured *and* the developer opted into early access. Gates every cloud surface. */
export function cloudAuthConfigured(): boolean {
	return cloudEarlyAccessEnabled({
		configured: CLOUD_CONFIGURED,
		featureFlags: ENVIRONMENT_FLAGS,
		preferenceEnabled: cloudPreferenceEnabled,
	});
}

export function setCloudPreferenceEnabled(enabled: boolean): void {
	cloudPreferenceEnabled = enabled;
}

export function cloudAvailability(): CloudAvailability {
	return {
		available: cloudDesktopAvailable(),
		enabled: cloudAuthConfigured(),
	};
}

function authGeneration(dataDir: string): number {
	return authGenerations.get(dataDir) ?? 0;
}

function invalidateAuthOperations(dataDir: string): number {
	const generation = authGeneration(dataDir) + 1;
	authGenerations.set(dataDir, generation);
	return generation;
}

async function withAuthMutation<T>(dataDir: string, mutation: () => Promise<T>): Promise<T> {
	const previous = authMutations.get(dataDir) ?? Promise.resolve();
	const result = previous.catch(() => undefined).then(mutation);
	const settled = result.then(
		() => undefined,
		() => undefined,
	);
	authMutations.set(dataDir, settled);
	try {
		return await result;
	} finally {
		if (authMutations.get(dataDir) === settled) authMutations.delete(dataDir);
	}
}

function storePath(dataDir: string): string {
	return path.join(dataDir, AUTH_STORE_FILE);
}

function protectedStorageAvailable(): boolean {
	// Unpackaged development builds can opt into process-only credentials so an
	// unsigned Electron binary does not block behind a Keychain prompt. Packaged
	// builds always use the OS-protected store.
	if (!app.isPackaged && process.env.AO_CLOUD_AUTH_MEMORY_ONLY === "1") return false;
	if (!safeStorage.isEncryptionAvailable()) return false;
	if (process.platform !== "linux") return true;
	// Linux's basic_text backend reports encryption as available while using a
	// hardcoded password, which is not protection for a rotating refresh token.
	const backend = safeStorage.getSelectedStorageBackend();
	return backend !== "basic_text" && backend !== "unknown";
}

async function readAuthStore(dataDir: string): Promise<AuthStore> {
	const memoryStore = memoryStores.get(dataDir);
	if (memoryStore) return memoryStore;
	let encrypted: Buffer;
	try {
		encrypted = await readFile(storePath(dataDir));
	} catch {
		// Do not probe safeStorage on a fresh install: on macOS the probe alone
		// can raise a Keychain prompt with no AO credential to decrypt.
		return emptyStore();
	}
	if (!protectedStorageAvailable()) {
		await rm(storePath(dataDir), { force: true });
		return emptyStore();
	}
	try {
		return JSON.parse(safeStorage.decryptString(encrypted)) as AuthStore;
	} catch {
		await rm(storePath(dataDir), { force: true });
		return emptyStore();
	}
}

async function writeAuthStore(dataDir: string, store: AuthStore): Promise<void> {
	if (!protectedStorageAvailable()) {
		memoryStores.set(dataDir, store);
		await rm(storePath(dataDir), { force: true });
		return;
	}
	memoryStores.delete(dataDir);
	await mkdir(dataDir, { recursive: true });
	const target = storePath(dataDir);
	await writeFile(target, safeStorage.encryptString(JSON.stringify(store)), { mode: 0o600 });
	await chmod(target, 0o600);
}

async function removeAuthStore(dataDir: string): Promise<void> {
	memoryStores.delete(dataDir);
	await Promise.all([
		rm(storePath(dataDir), { force: true }),
		rm(path.join(dataDir, LEGACY_SESSION_FILE), { force: true }),
	]);
}

function normalizeCurrentAccount(account: CurrentAccount): Pick<StoredSession, "user" | "organizations"> {
	return {
		user: account.user,
		organizations: account.organizations.map((organization) => {
			// Staging originally returned id/slug even though the generated cloud
			// contract names these fields orgId/orgSlug. Accept that deployed shape
			// while corrected control planes roll out, but keep one renderer shape.
			const membership = organization as typeof organization & { id?: string; slug?: string };
			return {
				id: membership.orgId || membership.id || "",
				slug: membership.orgSlug || membership.slug || "",
				displayName: membership.displayName,
				role: membership.role,
			};
		}),
	};
}

async function fetchCurrentAccount(accessToken: string): Promise<Pick<StoredSession, "user" | "organizations">> {
	const account = await createCloudClient({
		baseUrl: CLOUD_API_URL,
		getAccessToken: () => accessToken,
	}).getCurrentAccount();
	return normalizeCurrentAccount(account);
}

function toStoredSession(
	response: CloudTokenSet,
	identity: Pick<StoredSession, "user" | "organizations">,
): StoredSession {
	return {
		authProvider: "google",
		user: identity.user,
		organizations: identity.organizations,
		storedAt: new Date().toISOString(),
		accessToken: response.accessToken,
		refreshToken: response.refreshToken,
		expiresAt: response.expiresAt,
	};
}

function publicAccount(session: StoredSession): CloudAccount {
	return {
		authProvider: session.authProvider,
		user: session.user,
		organizations: session.organizations,
		storedAt: session.storedAt,
	};
}

function tokenExpiresSoon(session: StoredSession): boolean {
	const expiry = Date.parse(session.expiresAt);
	return !Number.isFinite(expiry) || Date.now() >= expiry - EXPIRY_SKEW_MS;
}

// A rotated-away, revoked, or rejected refresh token is unrecoverable: drop the
// session. Anything else (offline, 5xx, DNS) must leave it in place.
function isTerminalRefreshFailure(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const candidate = error as { status?: unknown; code?: unknown };
	return candidate.status === 401 || candidate.status === 403 || candidate.code === "INVALID_REFRESH_TOKEN";
}

/**
 * Return the stored session, refreshing it first when the access token is at or
 * near expiry. A non-terminal refresh failure keeps the existing session so a
 * network blip does not sign the user out; the caller that actually needs a
 * token ({@link getCloudAccessToken}) reports that separately.
 */
async function currentSession(dataDir: string): Promise<StoredSession | null> {
	if (!cloudAuthConfigured()) return null;
	const activeRefresh = refreshes.get(dataDir);
	if (activeRefresh) return activeRefresh;
	const store = await readAuthStore(dataDir);
	if (!store.session) return null;
	if (!tokenExpiresSoon(store.session)) return store.session;
	// Re-check after the store read: concurrent callers all observe the same
	// pre-rotation state, and only the first may consume the refresh token.
	const pendingRefresh = refreshes.get(dataDir);
	if (pendingRefresh) return pendingRefresh;
	const refresh = refreshCloudSession(dataDir, store.session, authGeneration(dataDir));
	refreshes.set(dataDir, refresh);
	try {
		return await refresh;
	} finally {
		if (refreshes.get(dataDir) === refresh) refreshes.delete(dataDir);
	}
}

export async function getCloudSession(dataDir: string): Promise<CloudAccount | null> {
	const session = await currentSession(dataDir);
	if (!session) return null;
	const identity = await fetchCurrentAccount(session.accessToken);
	return publicAccount({ ...session, ...identity });
}

async function refreshCloudSession(
	dataDir: string,
	storedSession: StoredSession,
	generation: number,
): Promise<StoredSession | null> {
	let response: CloudTokenSet;
	try {
		response = await createCloudClient({
			baseUrl: CLOUD_API_URL,
			getAccessToken: () => null,
		}).refreshSession({ refreshToken: storedSession.refreshToken });
	} catch (error) {
		if (!isTerminalRefreshFailure(error)) return storedSession;
		await withAuthMutation(dataDir, async () => {
			if (authGeneration(dataDir) !== generation) return;
			const currentStore = await readAuthStore(dataDir);
			if (currentStore.session?.refreshToken === storedSession.refreshToken) await removeAuthStore(dataDir);
		});
		return null;
	}
	const session = toStoredSession(response, storedSession);
	return withAuthMutation(dataDir, async () => {
		// A sign-out or a fresh sign-in raced this refresh: the rotated token now
		// belongs to nobody, and writing it back would resurrect a dead session.
		if (authGeneration(dataDir) !== generation) return null;
		const currentStore = await readAuthStore(dataDir);
		if (currentStore.session?.refreshToken !== storedSession.refreshToken) return null;
		await writeAuthStore(dataDir, { session });
		return session;
	});
}

/**
 * A currently valid AO access token for the renderer's cloud client. Throws
 * rather than handing back an expired token, so a failed refresh surfaces as a
 * request failure the UI can retry instead of a silent 401 loop.
 */
export async function getCloudAccessToken(dataDir: string): Promise<string> {
	const session = await currentSession(dataDir);
	if (!session) throw new Error("Sign in to AO Cloud first.");
	if (tokenExpiresSoon(session)) throw new Error("The AO Cloud session could not be refreshed.");
	return session.accessToken;
}

function base64url(value: Buffer): string {
	return value.toString("base64url");
}

/**
 * Own an ephemeral loopback listener for one authorization redirect (RFC 8252
 * §7.3). The port is chosen by the OS and the server is closed as soon as the
 * code arrives, the flow fails, or the timeout fires.
 *
 * The redirect can land before the caller has opened the browser (a stubbed or
 * very fast browser), so the settlement handlers and the timeout are wired at
 * listen time, not lazily on first await.
 */
async function listenForAuthorizationCode(
	state: string,
	timeoutMs: number,
): Promise<{ redirectURI: string; code: Promise<string>; cancel: () => void }> {
	let settle: ((value: string) => void) | undefined;
	let fail: ((error: Error) => void) | undefined;
	const received = new Promise<string>((resolve, reject) => {
		settle = resolve;
		fail = reject;
	});
	const server = createServer((request, response) => {
		const requestURL = new URL(request.url || "/", "http://127.0.0.1");
		if (requestURL.pathname !== "/callback") {
			response.writeHead(404).end();
			return;
		}
		response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		response.end("<!doctype html><title>AO Cloud</title><p>Signed in. You can return to Agent Orchestrator.</p>");
		const error = requestURL.searchParams.get("error");
		const callbackState = requestURL.searchParams.get("state");
		const code = requestURL.searchParams.get("code");
		if (error) fail?.(new Error(`Google sign-in failed: ${error}`));
		else if (callbackState !== state) fail?.(new Error("Google callback state did not match."));
		else if (!code) fail?.(new Error("Google callback is incomplete."));
		else settle?.(code);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const { port } = server.address() as AddressInfo;
	const timer = setTimeout(() => fail?.(new Error("The Google sign-in request expired.")), timeoutMs);
	const code = received.finally(() => {
		clearTimeout(timer);
		server.close();
	});
	// The redirect can arrive before the caller awaits `code`; without a standing
	// handler that window is reported as an unhandled rejection. The caller still
	// receives the rejection from its own await.
	code.catch(() => undefined);
	return {
		redirectURI: `http://127.0.0.1:${port}/callback`,
		code,
		cancel: () => fail?.(new Error("The Google sign-in request was cancelled.")),
	};
}

async function exchangeGoogleCode(code: string, codeVerifier: string, redirectURI: string): Promise<string> {
	const body = new URLSearchParams({
		client_id: GOOGLE_CLIENT_ID,
		code,
		code_verifier: codeVerifier,
		redirect_uri: redirectURI,
		grant_type: "authorization_code",
	});
	if (GOOGLE_CLIENT_SECRET) body.set("client_secret", GOOGLE_CLIENT_SECRET);
	const response = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});
	const token = (await response.json().catch(() => null)) as { id_token?: string } | null;
	if (!response.ok || !token?.id_token) throw new Error("Google did not return a valid identity token.");
	return token.id_token;
}

export async function beginCloudSignIn(dataDir: string): Promise<CloudAccount> {
	if (!cloudAuthConfigured()) throw new Error("AO Cloud sign-in is not configured.");
	const state = base64url(randomBytes(24));
	const codeVerifier = base64url(randomBytes(48));
	const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());

	const { redirectURI, code, cancel } = await listenForAuthorizationCode(state, SIGN_IN_TIMEOUT_MS);
	const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	authorize.search = new URLSearchParams({
		client_id: GOOGLE_CLIENT_ID,
		redirect_uri: redirectURI,
		response_type: "code",
		scope: "openid email profile",
		code_challenge: codeChallenge,
		code_challenge_method: "S256",
		state,
		prompt: "select_account",
	}).toString();
	try {
		await shell.openExternal(authorize.toString());
	} catch (error) {
		// Nothing will ever hit the redirect: release the listener now instead of
		// holding a loopback port until the sign-in timeout.
		cancel();
		throw error;
	}

	const idToken = await exchangeGoogleCode(await code, codeVerifier, redirectURI);
	const response = await createCloudClient({
		baseUrl: CLOUD_API_URL,
		getAccessToken: () => null,
	}).exchangeGoogleIdentity({ idToken });
	const session = toStoredSession(response, await fetchCurrentAccount(response.accessToken));
	// Retire any in-flight refresh for the session this one replaces before the
	// write, so a late rotation cannot land on top of the new credentials.
	invalidateAuthOperations(dataDir);
	await withAuthMutation(dataDir, () => writeAuthStore(dataDir, { session }));
	return publicAccount(session);
}

export async function signOutCloud(dataDir: string): Promise<void> {
	invalidateAuthOperations(dataDir);
	const { session } = await readAuthStore(dataDir);
	if (session) {
		// Best effort: a revoke that cannot reach the control plane must still
		// clear local custody. The token expires server-side regardless.
		await createCloudClient({
			baseUrl: CLOUD_API_URL,
			getAccessToken: () => null,
		}).logoutSession({ refreshToken: session.refreshToken }).catch(() => undefined);
	}
	await withAuthMutation(dataDir, () => removeAuthStore(dataDir));
}

function signInFailureDetail(error: unknown): string {
	const message = error instanceof Error ? error.message.toLowerCase() : "";
	if (message.includes("cancel") || message.includes("access_denied")) {
		return "Google sign-in was cancelled. You can try again whenever you are ready.";
	}
	if (message.includes("expired")) return "The Google sign-in request expired. Start sign-in again to continue.";
	if (message.includes("state") || message.includes("incomplete")) {
		return "The Google response could not be verified. Start sign-in again to continue.";
	}
	if (message.includes("network") || message.includes("fetch")) {
		return "Agent Orchestrator could not reach Google or AO Cloud. Check your connection and try again.";
	}
	return "Agent Orchestrator could not complete Google sign-in. Please try again.";
}

export async function showCloudSignInFailure(error: unknown): Promise<void> {
	await dialog.showMessageBox({
		type: "error",
		title: "AO Cloud sign-in failed",
		message: "Unable to sign in to AO Cloud",
		detail: signInFailureDetail(error),
	});
}

export function installCloudIPC(
	getDataDir: () => string,
	notifyRenderers: (session: CloudAccount | null) => void,
): void {
	installCloudProjectIPC({
		baseUrl: CLOUD_API_URL,
		getAccessToken: () => getCloudAccessToken(getDataDir()),
		getAccount: () => getCloudSession(getDataDir()),
	});
	ipcMain.handle("cloud:getAvailability", () => cloudAvailability());
	ipcMain.handle("cloud:getSession", () => getCloudSession(getDataDir()));
	ipcMain.handle("cloud:signIn", async () => {
		if (!cloudAuthConfigured()) {
			await dialog.showMessageBox({
				type: "info",
				title: "AO Cloud not configured",
				message: "AO Cloud sign-in is not configured.",
				detail: "Set the AO Cloud API URL and Google client ID, then restart Agent Orchestrator.",
			});
			return null;
		}
		try {
			const account = await beginCloudSignIn(getDataDir());
			notifyRenderers(account);
			return account;
		} catch (error) {
			await showCloudSignInFailure(error);
			return null;
		}
	});
	ipcMain.handle("cloud:signOut", async () => {
		await signOutCloud(getDataDir());
		notifyRenderers(null);
	});
}
