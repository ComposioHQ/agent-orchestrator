import { createDecipheriv, createHash, pbkdf2Sync, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import {
	access,
	lstat,
	mkdir,
	open,
	readdir,
	realpath,
	rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import Database from "better-sqlite3";
import type { CookiesSetDetails } from "electron";
import {
	BROWSER_IMPORT_MAX_COOKIES,
	BROWSER_IMPORT_MAX_DOMAINS,
	BROWSER_IMPORT_MAX_HISTORY_ENTRIES,
	BROWSER_IMPORT_MAX_SOURCE_PROFILES,
	type BrowserImportCookieSupportReason,
	type BrowserImportDiscovery,
	type BrowserImportProgress,
	type BrowserImportRequest,
	type BrowserImportResult,
	type BrowserImportResultEntry,
	type BrowserImportSource,
	type BrowserImportWarning,
} from "../shared/browser-profile-import";
import {
	browserProfilePartition,
	isBrowserProfileId,
	normalizeBrowserProfileName,
	type BrowserProfile,
} from "../shared/browser-profiles";
import { BrowserHistoryStore, type BrowserHistoryEntry } from "./browser-history-store";
import { BrowserProfileStore } from "./browser-profile-store";

const execFileAsync = promisify(execFile);
const SOURCE_FILE_MAX_BYTES = 256 * 1024 * 1024;
const SOURCE_SIDECAR_MAX_BYTES = 64 * 1024 * 1024;
const IMPORT_TOTAL_MAX_BYTES = 512 * 1024 * 1024;
const LOCAL_STATE_MAX_BYTES = 4 * 1024 * 1024;
const SOURCE_ID_PATTERN = /^[0-9a-f]{32}$/;

type BrowserFamily = "chromium" | "firefox";

type BrowserDescriptor = {
	id: string;
	name: string;
	family: BrowserFamily;
	roots: (context: DiscoveryContext) => string[];
	chromiumKeychainNames?: string[];
};

type DiscoveryContext = {
	platform: NodeJS.Platform;
	homeDir: string;
	env: NodeJS.ProcessEnv;
};

type InternalSourceProfile = {
	id: string;
	name: string;
	default: boolean;
	root: string;
};

type InternalSource = {
	public: BrowserImportSource;
	descriptor: BrowserDescriptor;
	root: string;
	profiles: InternalSourceProfile[];
};

type ImportedCookie = CookiesSetDetails & {
	dedupeKey: string;
};

type ReadProfileData = {
	profile: InternalSourceProfile;
	cookies: ImportedCookie[];
	history: BrowserHistoryEntry[];
	warnings: BrowserImportWarning[];
	skippedCookies: number;
};

type ImportSession = {
	cookies: { set: (details: CookiesSetDetails) => Promise<void> };
	clearStorageData: () => Promise<void>;
	clearCache: () => Promise<void>;
};

export type BrowserProfileImportOptions = {
	stateDir: string;
	profileStore: BrowserProfileStore;
	historyStore: BrowserHistoryStore;
	fromPartition: (partition: string) => ImportSession;
	platform?: NodeJS.Platform;
	homeDir?: string;
	env?: NodeJS.ProcessEnv;
	now?: () => Date;
};

class SourceBudget {
	private used = 0;

	consume(bytes: number): void {
		if (!Number.isSafeInteger(bytes) || bytes < 0 || this.used + bytes > IMPORT_TOTAL_MAX_BYTES) {
			throw new Error("Selected browser data exceeds the import size limit.");
		}
		this.used += bytes;
	}
}

const DESCRIPTORS: BrowserDescriptor[] = [
	{
		id: "chrome",
		name: "Google Chrome",
		family: "chromium",
		chromiumKeychainNames: ["Chrome", "Google Chrome"],
		roots: (c) => platformPaths(c, {
			win32: [joinEnv(c.env.LOCALAPPDATA, "Google", "Chrome", "User Data")],
			darwin: [path.join(c.homeDir, "Library", "Application Support", "Google", "Chrome")],
			linux: [path.join(configHome(c), "google-chrome")],
		}),
	},
	{
		id: "edge",
		name: "Microsoft Edge",
		family: "chromium",
		chromiumKeychainNames: ["Microsoft Edge"],
		roots: (c) => platformPaths(c, {
			win32: [joinEnv(c.env.LOCALAPPDATA, "Microsoft", "Edge", "User Data")],
			darwin: [path.join(c.homeDir, "Library", "Application Support", "Microsoft Edge")],
			linux: [path.join(configHome(c), "microsoft-edge")],
		}),
	},
	{
		id: "brave",
		name: "Brave",
		family: "chromium",
		chromiumKeychainNames: ["Brave", "Brave Browser"],
		roots: (c) => platformPaths(c, {
			win32: [joinEnv(c.env.LOCALAPPDATA, "BraveSoftware", "Brave-Browser", "User Data")],
			darwin: [path.join(c.homeDir, "Library", "Application Support", "BraveSoftware", "Brave-Browser")],
			linux: [path.join(configHome(c), "BraveSoftware", "Brave-Browser")],
		}),
	},
	{
		id: "chromium",
		name: "Chromium",
		family: "chromium",
		chromiumKeychainNames: ["Chromium"],
		roots: (c) => platformPaths(c, {
			win32: [joinEnv(c.env.LOCALAPPDATA, "Chromium", "User Data")],
			darwin: [path.join(c.homeDir, "Library", "Application Support", "Chromium")],
			linux: [path.join(configHome(c), "chromium")],
		}),
	},
	{
		id: "vivaldi",
		name: "Vivaldi",
		family: "chromium",
		chromiumKeychainNames: ["Vivaldi"],
		roots: (c) => platformPaths(c, {
			win32: [joinEnv(c.env.LOCALAPPDATA, "Vivaldi", "User Data")],
			darwin: [path.join(c.homeDir, "Library", "Application Support", "Vivaldi")],
			linux: [path.join(configHome(c), "vivaldi")],
		}),
	},
	{
		id: "arc",
		name: "Arc",
		family: "chromium",
		chromiumKeychainNames: ["Arc"],
		roots: (c) => platformPaths(c, {
			win32: [],
			darwin: [path.join(c.homeDir, "Library", "Application Support", "Arc", "User Data")],
			linux: [],
		}),
	},
	{
		id: "firefox",
		name: "Firefox",
		family: "firefox",
		roots: (c) => platformPaths(c, {
			win32: [joinEnv(c.env.APPDATA, "Mozilla", "Firefox")],
			darwin: [path.join(c.homeDir, "Library", "Application Support", "Firefox")],
			linux: [path.join(c.homeDir, ".mozilla", "firefox")],
		}),
	},
	{
		id: "zen",
		name: "Zen",
		family: "firefox",
		roots: (c) => platformPaths(c, {
			win32: [joinEnv(c.env.APPDATA, "zen")],
			darwin: [path.join(c.homeDir, "Library", "Application Support", "zen")],
			linux: [path.join(c.homeDir, ".zen")],
		}),
	},
];

function configHome(context: DiscoveryContext): string {
	return context.env.XDG_CONFIG_HOME || path.join(context.homeDir, ".config");
}

function joinEnv(root: string | undefined, ...parts: string[]): string {
	return root ? path.join(root, ...parts) : "";
}

function platformPaths(
	context: DiscoveryContext,
	paths: Record<"win32" | "darwin" | "linux", string[]>,
): string[] {
	if (context.platform === "win32") return paths.win32.filter(Boolean);
	if (context.platform === "darwin") return paths.darwin.filter(Boolean);
	return paths.linux.filter(Boolean);
}

function opaqueSourceId(kind: string, canonicalPath: string): string {
	return createHash("sha256").update(kind).update("\0").update(canonicalPath).digest("hex").slice(0, 32);
}

function contained(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function existingRealDirectory(candidate: string): Promise<string | null> {
	if (!candidate) return null;
	try {
		const metadata = await lstat(candidate);
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) return null;
		return await realpath(candidate);
	} catch {
		return null;
	}
}

async function readSmallJSON(file: string, maxBytes: number): Promise<unknown> {
	const metadata = await lstat(file);
	if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxBytes) {
		throw new Error("Browser metadata exceeds the size limit.");
	}
	const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
	const handle = await open(file, constants.O_RDONLY | noFollow);
	try {
		const opened = await handle.stat();
		if (!opened.isFile() || opened.size > maxBytes) throw new Error("Browser metadata exceeds the size limit.");
		return JSON.parse(await handle.readFile("utf8"));
	} finally {
		await handle.close().catch(() => undefined);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function discoverChromiumProfiles(descriptor: BrowserDescriptor, root: string): Promise<InternalSourceProfile[]> {
	const names = new Map<string, string>();
	try {
		const localState = await readSmallJSON(path.join(root, "Local State"), LOCAL_STATE_MAX_BYTES);
		if (isRecord(localState) && isRecord(localState.profile) && isRecord(localState.profile.info_cache)) {
			for (const [directory, raw] of Object.entries(localState.profile.info_cache)) {
				if (!isRecord(raw)) continue;
				const name = typeof raw.name === "string" ? raw.name.trim() : "";
				if (name) names.set(directory, name);
			}
		}
	} catch {
		// A missing or malformed Local State does not hide otherwise valid profiles.
	}
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	const directories = new Set<string>([
		...names.keys(),
		...entries
			.filter((entry) => entry.isDirectory() && (entry.name === "Default" || /^Profile \d+$/.test(entry.name)))
			.map((entry) => entry.name),
	]);
	const profiles: InternalSourceProfile[] = [];
	for (const directory of directories) {
		const profileRoot = await existingRealDirectory(path.join(root, directory));
		if (!profileRoot || !contained(root, profileRoot) || !(await hasImportableDatabase(profileRoot, "chromium"))) continue;
		profiles.push({
			id: opaqueSourceId(`${descriptor.id}:profile`, profileRoot),
			name: names.get(directory) || (directory === "Default" ? "Default" : directory),
			default: directory === "Default",
			root: profileRoot,
		});
	}
	return profiles.sort((a, b) => Number(b.default) - Number(a.default) || a.name.localeCompare(b.name));
}

async function discoverFirefoxProfiles(descriptor: BrowserDescriptor, root: string): Promise<InternalSourceProfile[]> {
	const profileParent = (await existingRealDirectory(path.join(root, "Profiles"))) ?? root;
	const entries = await readdir(profileParent, { withFileTypes: true }).catch(() => []);
	const profiles: InternalSourceProfile[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const profileRoot = await existingRealDirectory(path.join(profileParent, entry.name));
		if (!profileRoot || !contained(root, profileRoot) || !(await hasImportableDatabase(profileRoot, "firefox"))) continue;
		const dot = entry.name.indexOf(".");
		const suffix = dot >= 0 ? entry.name.slice(dot + 1) : entry.name;
		profiles.push({
			id: opaqueSourceId(`${descriptor.id}:profile`, profileRoot),
			name: suffix || entry.name,
			default: /default|release/i.test(suffix),
			root: profileRoot,
		});
	}
	return profiles.sort((a, b) => Number(b.default) - Number(a.default) || a.name.localeCompare(b.name));
}

async function hasImportableDatabase(profileRoot: string, family: BrowserFamily): Promise<boolean> {
	const candidates =
		family === "chromium"
			? ["History", path.join("Network", "Cookies"), "Cookies"]
			: ["places.sqlite", "cookies.sqlite"];
	for (const relative of candidates) {
		try {
			const metadata = await lstat(path.join(profileRoot, relative));
			if (metadata.isFile() && !metadata.isSymbolicLink()) return true;
		} catch {
			// Continue looking for another supported database.
		}
	}
	return false;
}

function cookieCapability(
	family: BrowserFamily,
	platform: NodeJS.Platform,
): { support: BrowserImportSource["cookieSupport"]; reason: BrowserImportCookieSupportReason } {
	if (family === "firefox") return { support: "supported", reason: "firefox-plaintext" };
	return {
		support: "partial",
		reason: platform === "linux" ? "chromium-encryption-unsupported" : "chromium-encryption-partial",
	};
}

export class BrowserProfileImportService {
	private readonly context: DiscoveryContext;
	private readonly now: () => Date;
	private active = false;

	constructor(private readonly options: BrowserProfileImportOptions) {
		this.context = {
			platform: options.platform ?? process.platform,
			homeDir: options.homeDir ?? os.homedir(),
			env: options.env ?? process.env,
		};
		this.now = options.now ?? (() => new Date());
	}

	async discover(): Promise<BrowserImportDiscovery> {
		return { sources: (await this.discoverInternal()).map((source) => source.public) };
	}

	private async discoverInternal(): Promise<InternalSource[]> {
		const sources: InternalSource[] = [];
		for (const descriptor of DESCRIPTORS) {
			for (const candidate of descriptor.roots(this.context)) {
				const root = await existingRealDirectory(candidate);
				if (!root) continue;
				const profiles =
					descriptor.family === "chromium"
						? await discoverChromiumProfiles(descriptor, root)
						: await discoverFirefoxProfiles(descriptor, root);
				if (profiles.length === 0) continue;
				const capability = cookieCapability(descriptor.family, this.context.platform);
				sources.push({
					descriptor,
					root,
					profiles,
					public: {
						id: opaqueSourceId(`${descriptor.id}:source`, root),
						name: descriptor.name,
						family: descriptor.family,
						profiles: profiles.map(({ id, name, default: isDefault }) => ({ id, name, default: isDefault })),
						cookieSupport: capability.support,
						cookieSupportReason: capability.reason,
						historySupport: true,
					},
				});
				break;
			}
		}
		return sources;
	}

	async import(
		rawRequest: BrowserImportRequest,
		onProgress: (progress: BrowserImportProgress) => void,
	): Promise<BrowserImportResult> {
		if (this.active) throw new Error("Another browser import is already running.");
		this.active = true;
		const staging = path.join(this.options.stateDir, "browser-import-staging", randomUUID());
		let sourceRoots: string[] = [];
		try {
			const sources = await this.discoverInternal();
			sourceRoots = sources.map((source) => source.root);
			const request = validateRequest(rawRequest, sources, this.options.profileStore.profiles);
			const source = sources.find((candidate) => candidate.public.id === request.sourceId)!;
			const selected = request.profileIds.map((id) => source.profiles.find((profile) => profile.id === id)!);
			onProgress({ requestId: request.requestId, phase: "preparing", completed: 0, total: selected.length });
			await mkdir(staging, { recursive: true, mode: 0o700 });
			const budget = new SourceBudget();
			const decryptor = await ChromiumCookieDecryptor.create(source, this.context.platform);
			const readData: ReadProfileData[] = [];
			for (const [index, profile] of selected.entries()) {
				readData.push(await readProfileData(source, profile, request, staging, budget, decryptor, this.now()));
				onProgress({ requestId: request.requestId, phase: "reading", completed: index + 1, total: selected.length });
			}
			return await this.commitImport(source, request, readData, onProgress);
		} catch (error) {
			throw redactSourcePaths(error, sourceRoots);
		} finally {
			await rm(staging, { recursive: true, force: true }).catch(() => undefined);
			this.active = false;
		}
	}

	private async commitImport(
		source: InternalSource,
		request: BrowserImportRequest,
		readData: ReadProfileData[],
		onProgress: (progress: BrowserImportProgress) => void,
	): Promise<BrowserImportResult> {
		const destination = request.destination;
		const groups =
			destination.mode === "merge"
				? [{ name: destination.name, data: readData }]
				: readData.map((data) => ({ name: destination.names[data.profile.id]!, data: [data] }));
		const created: BrowserProfile[] = [];
		const results: BrowserImportResultEntry[] = [];
		try {
			for (const [index, group] of groups.entries()) {
				const profile = await this.options.profileStore.createProfile(group.name);
				created.push(profile);
				const history = group.data.flatMap((data) => data.history);
				const cookies = dedupeCookies(group.data.flatMap((data) => data.cookies));
				const importedHistoryEntries = request.includeHistory
					? await this.options.historyStore.mergeImportedEntries(profile.id, history)
					: 0;
				const cookieOutcome = request.includeCookies
					? await setCookies(this.options.fromPartition(browserProfilePartition(profile.id)), cookies)
					: { imported: 0, skipped: 0, warnings: [] };
				results.push({
					sourceProfileNames: group.data.map((data) => data.profile.name),
					destinationProfile: profile,
					importedCookies: cookieOutcome.imported,
					skippedCookies: group.data.reduce((total, data) => total + data.skippedCookies, 0) + cookieOutcome.skipped,
					importedHistoryEntries,
					warnings: mergeWarnings([...group.data.flatMap((data) => data.warnings), ...cookieOutcome.warnings]),
				});
				onProgress({ requestId: request.requestId, phase: "importing", completed: index + 1, total: groups.length });
			}
			return { sourceName: source.public.name, entries: results };
		} catch (error) {
			for (const profile of created.reverse()) {
				let importedSession: ImportSession | undefined;
				try {
					importedSession = this.options.fromPartition(browserProfilePartition(profile.id));
				} catch {
					// Registry and AO-owned history cleanup must still run even if
					// Electron cannot recreate the destination session.
				}
				await Promise.allSettled([
					this.options.historyStore.clear(profile.id),
					...(importedSession ? [importedSession.clearStorageData(), importedSession.clearCache()] : []),
				]);
				await this.options.profileStore.deleteProfile(profile.id).catch(() => undefined);
			}
			throw error;
		}
	}
}

function redactSourcePaths(error: unknown, sourceRoots: string[]): Error {
	let message = error instanceof Error ? error.message : "Browser data could not be imported.";
	for (const root of sourceRoots.sort((a, b) => b.length - a.length)) {
		for (const variant of new Set([root, root.replaceAll("\\", "/")])) {
			message = message.replaceAll(variant, "<browser source>");
		}
	}
	return new Error(message || "Browser data could not be imported.");
}

function validateRequest(
	request: BrowserImportRequest,
	sources: InternalSource[],
	existingProfiles: BrowserProfile[],
): BrowserImportRequest {
	if (!isRecord(request) || !isBrowserProfileId(request.requestId)) throw new Error("Browser import request ID is invalid.");
	if (typeof request.sourceId !== "string" || !SOURCE_ID_PATTERN.test(request.sourceId)) throw new Error("Browser import source is invalid.");
	const source = sources.find((candidate) => candidate.public.id === request.sourceId);
	if (!source) throw new Error("The selected browser source is no longer available.");
	if (
		!Array.isArray(request.profileIds) ||
		request.profileIds.length === 0 ||
		request.profileIds.length > BROWSER_IMPORT_MAX_SOURCE_PROFILES ||
		new Set(request.profileIds).size !== request.profileIds.length ||
		request.profileIds.some((id) => typeof id !== "string" || !source.profiles.some((profile) => profile.id === id))
	) {
		throw new Error("Selected browser profiles are invalid.");
	}
	if (request.includeCookies !== true && request.includeHistory !== true) throw new Error("Select cookies, history, or both.");
	if (!Array.isArray(request.domains) || request.domains.length > BROWSER_IMPORT_MAX_DOMAINS) throw new Error("Domain filters are invalid.");
	const domains = normalizeDomains(request.domains);
	const destination = request.destination;
	if (!isRecord(destination) || (destination.mode !== "separate" && destination.mode !== "merge")) {
		throw new Error("Browser import destination is invalid.");
	}
	let names: string[];
	if (destination.mode === "merge") {
		const name = normalizeBrowserProfileName(destination.name);
		if (!name || name !== destination.name) throw new Error("Destination profile name is invalid.");
		names = [name];
	} else {
		if (!isRecord(destination.names)) throw new Error("Destination profile names are invalid.");
		names = request.profileIds.map((id) => {
			if (!Object.hasOwn(destination.names, id)) throw new Error("A destination profile name is missing.");
			const name = normalizeBrowserProfileName(destination.names[id]);
			if (!name || name !== destination.names[id]) throw new Error("Destination profile name is invalid.");
			return name;
		});
	}
	const normalizedNames = names.map((name) => name.toLowerCase());
	if (new Set(normalizedNames).size !== normalizedNames.length) throw new Error("Destination profile names must be unique.");
	const existing = new Set(existingProfiles.map((profile) => profile.name.toLowerCase()));
	if (normalizedNames.some((name) => existing.has(name))) throw new Error("A destination browser profile already exists.");
	return { ...request, domains };
}

function normalizeDomains(values: string[]): string[] {
	const domains: string[] = [];
	const seen = new Set<string>();
	for (const raw of values) {
		if (typeof raw !== "string") throw new Error("Domain filters are invalid.");
		let value = raw.trim().toLowerCase();
		if (value.startsWith("*.")) value = value.slice(2);
		while (value.startsWith(".")) value = value.slice(1);
		if (!value || value.length > 253 || value.includes("/") || value.includes(":")) throw new Error("Domain filters are invalid.");
		let hostname: string;
		try {
			hostname = new URL(`https://${value}`).hostname.toLowerCase();
		} catch {
			throw new Error("Domain filters are invalid.");
		}
		if (hostname !== value || seen.has(hostname)) continue;
		seen.add(hostname);
		domains.push(hostname);
	}
	return domains;
}

async function readProfileData(
	source: InternalSource,
	profile: InternalSourceProfile,
	request: BrowserImportRequest,
	staging: string,
	budget: SourceBudget,
	decryptor: ChromiumCookieDecryptor,
	now: Date,
): Promise<ReadProfileData> {
	const warnings: BrowserImportWarning[] = [];
	let cookies: ImportedCookie[] = [];
	let history: BrowserHistoryEntry[] = [];
	let skippedCookies = 0;
	if (request.includeCookies) {
		const cookieDatabase = await findDatabase(profile.root, source.descriptor.family === "chromium"
			? [path.join("Network", "Cookies"), "Cookies"]
			: ["cookies.sqlite"]);
		if (!cookieDatabase) {
			warnings.push({ code: "cookie-database-missing" });
		} else {
			const snapshot = await snapshotSQLite(cookieDatabase, profile.root, staging, budget);
			const outcome = source.descriptor.family === "chromium"
				? readChromiumCookies(snapshot, request.domains, decryptor, now)
				: readFirefoxCookies(snapshot, request.domains, now);
			cookies = outcome.cookies;
			skippedCookies += outcome.skipped;
			warnings.push(...outcome.warnings);
		}
	}
	if (request.includeHistory) {
		const historyDatabase = await findDatabase(profile.root, source.descriptor.family === "chromium" ? ["History"] : ["places.sqlite"]);
		if (!historyDatabase) {
			warnings.push({ code: "history-database-missing" });
		} else {
			const snapshot = await snapshotSQLite(historyDatabase, profile.root, staging, budget);
			history = source.descriptor.family === "chromium"
				? readChromiumHistory(snapshot, request.domains)
				: readFirefoxHistory(snapshot, request.domains);
		}
	}
	return { profile, cookies, history, warnings: mergeWarnings(warnings), skippedCookies };
}

async function findDatabase(profileRoot: string, relatives: string[]): Promise<string | null> {
	for (const relative of relatives) {
		const candidate = path.join(profileRoot, relative);
		try {
			const metadata = await lstat(candidate);
			if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
			const canonical = await realpath(candidate);
			if (contained(profileRoot, canonical)) return canonical;
		} catch {
			// Try the next known location.
		}
	}
	return null;
}

async function snapshotSQLite(
	database: string,
	profileRoot: string,
	staging: string,
	budget: SourceBudget,
): Promise<string> {
	const destination = path.join(staging, `${randomUUID()}-${path.basename(database)}`);
	await copyContainedFile(database, profileRoot, destination, SOURCE_FILE_MAX_BYTES, budget);
	for (const suffix of ["-wal", "-shm"]) {
		const sidecar = `${database}${suffix}`;
		try {
			await access(sidecar, constants.F_OK);
			await copyContainedFile(sidecar, profileRoot, `${destination}${suffix}`, SOURCE_SIDECAR_MAX_BYTES, budget);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return destination;
}

async function copyContainedFile(
	source: string,
	root: string,
	destination: string,
	maxBytes: number,
	budget: SourceBudget,
): Promise<void> {
	const metadata = await lstat(source);
	if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxBytes) {
		throw new Error("Browser source database is invalid or exceeds the size limit.");
	}
	const canonical = await realpath(source);
	if (!contained(root, canonical)) throw new Error("Browser source database is outside its profile directory.");
	const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
	const sourceHandle = await open(source, constants.O_RDONLY | noFollow);
	try {
		const opened = await sourceHandle.stat();
		if (!opened.isFile() || opened.size > maxBytes) throw new Error("Browser source database exceeds the size limit.");
		budget.consume(opened.size);
		await pipeline(sourceHandle.createReadStream(), createWriteStream(destination, { flags: "wx", mode: 0o600 }));
	} finally {
		await sourceHandle.close().catch(() => undefined);
	}
}

function withReadOnlyDatabase<T>(file: string, read: (database: Database) => T): T {
	const database = new Database(file, { readonly: true, fileMustExist: true, timeout: 5_000 });
	try {
		database.pragma("query_only = ON");
		return read(database);
	} finally {
		database.close();
	}
}

function readFirefoxCookies(file: string, domains: string[], now: Date): { cookies: ImportedCookie[]; skipped: number; warnings: BrowserImportWarning[] } {
	return withReadOnlyDatabase(file, (database) => {
		const rows = database.prepare(`
			SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite
			FROM moz_cookies
			LIMIT ${BROWSER_IMPORT_MAX_COOKIES}
		`).all() as Record<string, unknown>[];
		return normalizeCookieRows(rows.map((row) => ({
			domain: row.host,
			name: row.name,
			value: row.value,
			path: row.path,
			expires: numberValue(row.expiry),
			secure: booleanValue(row.isSecure),
			httpOnly: booleanValue(row.isHttpOnly),
			sameSite: firefoxSameSite(numberValue(row.sameSite)),
		})), domains, now);
	});
}

function readChromiumCookies(
	file: string,
	domains: string[],
	decryptor: ChromiumCookieDecryptor,
	now: Date,
): { cookies: ImportedCookie[]; skipped: number; warnings: BrowserImportWarning[] } {
	return withReadOnlyDatabase(file, (database) => {
		const rows = database.prepare(`
			SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite
			FROM cookies
			LIMIT ${BROWSER_IMPORT_MAX_COOKIES}
		`).all() as Record<string, unknown>[];
		let encryptedSkipped = 0;
		const raw: Array<Record<string, unknown>> = [];
		for (const row of rows) {
			const domain = stringValue(row.host_key);
			let value = stringValue(row.value);
			if (!value) {
				const encrypted = Buffer.isBuffer(row.encrypted_value) ? row.encrypted_value : Buffer.alloc(0);
				value = decryptor.decrypt(encrypted, domain) ?? "";
				if (!value && encrypted.length > 0) {
					encryptedSkipped += 1;
					continue;
				}
			}
			raw.push({
				domain,
				name: row.name,
				value,
				path: row.path,
				expires: chromiumTimestamp(numberValue(row.expires_utc)),
				secure: booleanValue(row.is_secure),
				httpOnly: booleanValue(row.is_httponly),
				sameSite: chromiumSameSite(numberValue(row.samesite)),
			});
		}
		const normalized = normalizeCookieRows(raw, domains, now);
		if (encryptedSkipped > 0) normalized.warnings.push({ code: "encrypted-cookies-skipped", count: encryptedSkipped });
		normalized.skipped += encryptedSkipped;
		return normalized;
	});
}

function normalizeCookieRows(
	rows: Array<Record<string, unknown>>,
	domains: string[],
	now: Date,
): { cookies: ImportedCookie[]; skipped: number; warnings: BrowserImportWarning[] } {
	const cookies: ImportedCookie[] = [];
	let expired = 0;
	let invalid = 0;
	for (const row of rows) {
		const domain = stringValue(row.domain).trim().toLowerCase();
		const hostname = domain.replace(/^\.+/, "");
		if (!hostname || !domainMatches(hostname, domains)) continue;
		const name = stringValue(row.name);
		const value = stringValue(row.value);
		if (!name) {
			invalid += 1;
			continue;
		}
		const expirationDate = typeof row.expires === "number" && Number.isFinite(row.expires) && row.expires > 0 ? row.expires : undefined;
		if (expirationDate !== undefined && expirationDate <= now.getTime() / 1_000) {
			expired += 1;
			continue;
		}
		const cookiePath = stringValue(row.path) || "/";
		const secure = row.secure === true;
		const sameSite = row.sameSite as CookiesSetDetails["sameSite"];
		try {
			const url = new URL(`${secure ? "https" : "http"}://${hostname}${cookiePath.startsWith("/") ? cookiePath : `/${cookiePath}`}`).href;
			cookies.push({
				url,
				name,
				value,
				domain,
				path: cookiePath,
				secure,
				httpOnly: row.httpOnly === true,
				...(sameSite ? { sameSite } : {}),
				...(expirationDate !== undefined ? { expirationDate } : {}),
				dedupeKey: `${name}\0${domain}\0${cookiePath}`,
			});
		} catch {
			invalid += 1;
		}
	}
	const warnings: BrowserImportWarning[] = [];
	if (expired > 0) warnings.push({ code: "expired-cookies-skipped", count: expired });
	if (invalid > 0) warnings.push({ code: "invalid-cookies-skipped", count: invalid });
	return { cookies, skipped: expired + invalid, warnings };
}

function readFirefoxHistory(file: string, domains: string[]): BrowserHistoryEntry[] {
	return withReadOnlyDatabase(file, (database) =>
		(database.prepare(`
			SELECT url, title, visit_count, last_visit_date
			FROM moz_places
			WHERE url LIKE 'http%'
			ORDER BY last_visit_date DESC
			LIMIT ${BROWSER_IMPORT_MAX_HISTORY_ENTRIES}
		`).all() as Record<string, unknown>[]).flatMap((row) => {
			const timestamp = numberValue(row.last_visit_date) / 1_000;
			return normalizeHistoryRow(row.url, row.title, row.visit_count, timestamp, domains);
		}),
	);
}

function readChromiumHistory(file: string, domains: string[]): BrowserHistoryEntry[] {
	return withReadOnlyDatabase(file, (database) =>
		(database.prepare(`
			SELECT url, title, visit_count, last_visit_time
			FROM urls
			WHERE url LIKE 'http%'
			ORDER BY last_visit_time DESC
			LIMIT ${BROWSER_IMPORT_MAX_HISTORY_ENTRIES}
		`).all() as Record<string, unknown>[]).flatMap((row) =>
			normalizeHistoryRow(row.url, row.title, row.visit_count, chromiumTimestamp(numberValue(row.last_visit_time)) * 1_000, domains),
		),
	);
}

function normalizeHistoryRow(
	rawURL: unknown,
	rawTitle: unknown,
	rawVisitCount: unknown,
	timestampMs: number,
	domains: string[],
): BrowserHistoryEntry[] {
	try {
		const url = new URL(stringValue(rawURL));
		if ((url.protocol !== "http:" && url.protocol !== "https:") || !domainMatches(url.hostname, domains)) return [];
		const title = stringValue(rawTitle).trim().slice(0, 512);
		const lastVisited = Number.isFinite(timestampMs) && timestampMs > 0 ? new Date(timestampMs).toISOString() : new Date(0).toISOString();
		return [{
			url: url.href,
			...(title ? { title } : {}),
			lastVisited,
			visitCount: Math.max(1, Math.trunc(numberValue(rawVisitCount)) || 1),
		}];
	} catch {
		return [];
	}
}

function chromiumTimestamp(rawMicroseconds: number): number {
	if (!Number.isFinite(rawMicroseconds) || rawMicroseconds <= 0) return 0;
	return rawMicroseconds / 1_000_000 - 11_644_473_600;
}

function firefoxSameSite(value: number): CookiesSetDetails["sameSite"] {
	if (value === 2) return "strict";
	if (value === 1) return "lax";
	if (value === 0) return "no_restriction";
	return "unspecified";
}

function chromiumSameSite(value: number): CookiesSetDetails["sameSite"] {
	if (value === 2) return "strict";
	if (value === 1) return "lax";
	if (value === 0) return "no_restriction";
	return "unspecified";
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
	return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : 0;
}

function booleanValue(value: unknown): boolean {
	return value === true || value === 1 || value === 1n;
}

function domainMatches(host: string, domains: string[]): boolean {
	if (domains.length === 0) return true;
	const normalized = host.toLowerCase().replace(/^\.+/, "");
	return domains.some((domain) => normalized === domain || normalized.endsWith(`.${domain}`));
}

function dedupeCookies(cookies: ImportedCookie[]): ImportedCookie[] {
	const byKey = new Map<string, ImportedCookie>();
	for (const cookie of cookies) {
		const existing = byKey.get(cookie.dedupeKey);
		if (!existing || (cookie.expirationDate ?? 0) >= (existing.expirationDate ?? 0)) byKey.set(cookie.dedupeKey, cookie);
	}
	return [...byKey.values()].slice(0, BROWSER_IMPORT_MAX_COOKIES);
}

async function setCookies(
	session: ImportSession,
	cookies: ImportedCookie[],
): Promise<{ imported: number; skipped: number; warnings: BrowserImportWarning[] }> {
	let imported = 0;
	let skipped = 0;
	for (const cookie of cookies) {
		const { dedupeKey: _dedupeKey, ...details } = cookie;
		try {
			await session.cookies.set(details);
			imported += 1;
		} catch {
			skipped += 1;
		}
	}
	return {
		imported,
		skipped,
		warnings: skipped > 0 ? [{ code: "cookie-write-failed", count: skipped }] : [],
	};
}

function mergeWarnings(warnings: BrowserImportWarning[]): BrowserImportWarning[] {
	const counts = new Map<BrowserImportWarning["code"], number | undefined>();
	for (const warning of warnings) {
		const current = counts.get(warning.code);
		counts.set(warning.code, warning.count === undefined ? current : (current ?? 0) + warning.count);
	}
	return [...counts].map(([code, count]) => ({ code, ...(count === undefined ? {} : { count }) }));
}

class ChromiumCookieDecryptor {
	private constructor(
		private readonly platform: NodeJS.Platform,
		private readonly key: Buffer | null,
	) {}

	static async create(source: InternalSource, platform: NodeJS.Platform): Promise<ChromiumCookieDecryptor> {
		if (source.descriptor.family !== "chromium") return new ChromiumCookieDecryptor(platform, null);
		if (platform === "win32") {
			try {
				const localState = await readSmallJSON(path.join(source.root, "Local State"), LOCAL_STATE_MAX_BYTES);
				if (!isRecord(localState) || !isRecord(localState.os_crypt) || typeof localState.os_crypt.encrypted_key !== "string") {
					return new ChromiumCookieDecryptor(platform, null);
				}
				const wrapped = Buffer.from(localState.os_crypt.encrypted_key, "base64");
				if (!wrapped.subarray(0, 5).equals(Buffer.from("DPAPI"))) return new ChromiumCookieDecryptor(platform, null);
				return new ChromiumCookieDecryptor(platform, await windowsDPAPIUnprotect(wrapped.subarray(5)));
			} catch {
				return new ChromiumCookieDecryptor(platform, null);
			}
		}
		if (platform === "darwin") {
			for (const name of source.descriptor.chromiumKeychainNames ?? []) {
				try {
					const { stdout } = await execFileAsync(
						"security",
						["find-generic-password", "-w", "-s", `${name} Safe Storage`],
						{ timeout: 10_000, maxBuffer: 16 * 1024 },
					);
					const password = stdout.trim();
					if (password) return new ChromiumCookieDecryptor(platform, Buffer.from(password));
				} catch {
					// Try the next legitimate Keychain service name.
				}
			}
		}
		return new ChromiumCookieDecryptor(platform, null);
	}

	decrypt(encrypted: Buffer, host: string): string | null {
		if (encrypted.length === 0 || !this.key) return null;
		if (this.platform === "win32") return decryptWindowsChromiumCookie(encrypted, this.key);
		if (this.platform === "darwin") return decryptMacChromiumCookie(encrypted, this.key, host);
		return null;
	}
}

function decryptWindowsChromiumCookie(encrypted: Buffer, key: Buffer): string | null {
	if (encrypted.subarray(0, 3).toString() !== "v10" && encrypted.subarray(0, 3).toString() !== "v11") return null;
	if (encrypted.length < 3 + 12 + 16) return null;
	try {
		const nonce = encrypted.subarray(3, 15);
		const payload = encrypted.subarray(15);
		const ciphertext = payload.subarray(0, -16);
		const authTag = payload.subarray(-16);
		const decipher = createDecipheriv("aes-256-gcm", key, nonce);
		decipher.setAuthTag(authTag);
		return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
	} catch {
		return null;
	}
}

function decryptMacChromiumCookie(encrypted: Buffer, password: Buffer, host: string): string | null {
	const prefix = encrypted.subarray(0, 3).toString();
	if (prefix !== "v10" && prefix !== "v11") return null;
	try {
		const key = pbkdf2Sync(password, "saltysalt", 1_003, 16, "sha1");
		const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
		let plaintext = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
		const hostDigest = createHash("sha256").update(host).digest();
		if (plaintext.subarray(0, hostDigest.length).equals(hostDigest)) plaintext = plaintext.subarray(hostDigest.length);
		return plaintext.toString("utf8");
	} catch {
		return null;
	}
}

async function windowsDPAPIUnprotect(input: Buffer): Promise<Buffer | null> {
	const script = [
		"Add-Type -AssemblyName System.Security",
		"$raw = [Console]::In.ReadToEnd()",
		"$bytes = [Convert]::FromBase64String($raw)",
		"$plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
		"[Console]::Out.Write([Convert]::ToBase64String($plain))",
	].join("; ");
	return new Promise((resolve) => {
		const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
			stdio: ["pipe", "pipe", "ignore"],
			windowsHide: true,
		});
		let stdout = "";
		const timer = setTimeout(() => child.kill(), 10_000);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (stdout.length < 32 * 1024) stdout += chunk;
		});
		child.once("error", () => {
			clearTimeout(timer);
			resolve(null);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) return resolve(null);
			try {
				resolve(Buffer.from(stdout.trim(), "base64"));
			} catch {
				resolve(null);
			}
		});
		child.stdin.end(input.toString("base64"));
	});
}
