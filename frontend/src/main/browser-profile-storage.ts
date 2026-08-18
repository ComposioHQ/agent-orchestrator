import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The one AO-owned persistent browser destination. Electron stores data for a
 * persistent partition below its session-data directory; main.ts pins that
 * directory under ~/.ao before Electron is ready.
 */
export const AO_BROWSER_PERSISTENT_PARTITION = "persist:ao-browser";
export const BROWSER_PROFILE_SETTINGS_FILE_NAME = "browser-profile-settings.json";
export const BROWSER_IMPORT_SUMMARY_FILE_NAME = "browser-import-summary.json";

const EPHEMERAL_PARTITION_PREFIX = "ao-browser-";

export type BrowserProfilePersistence = "ephemeral" | "persistent";

export type BrowserImportBrowser = "chrome" | "edge" | "brave";

export type BrowserImportSummary = {
	sourceBrowser: BrowserImportBrowser;
	sourceProfile: string;
	importedBookmarks: number;
	skippedBookmarks: number;
	importedAt: string;
};

export type BrowserProfileStorageOptions = {
	stateDir?: string;
	randomId?: () => string;
};

/**
 * Main-process-only seam for choosing the browser storage destination. The
 * persistent destination is deliberately singular; named profiles and source
 * browser storage do not belong in this layer.
 */
export type BrowserProfileStorage = {
	partitionFor: (persistence?: BrowserProfilePersistence) => string;
	getPersistence: () => BrowserProfilePersistence;
	load: () => Promise<BrowserProfilePersistence>;
	selectPersistence: (persistence: BrowserProfilePersistence) => Promise<BrowserProfilePersistence>;
	readImportSummary: () => Promise<BrowserImportSummary | null>;
	writeImportSummary: (summary: BrowserImportSummary) => Promise<BrowserImportSummary>;
	isPersistentDestinationActive: () => boolean;
};

const DEFAULT_PERSISTENCE: BrowserProfilePersistence = "ephemeral";

function coercePersistence(value: unknown): BrowserProfilePersistence {
	return value === "persistent" ? "persistent" : DEFAULT_PERSISTENCE;
}

function coerceSummary(value: unknown): BrowserImportSummary | null {
	if (typeof value !== "object" || value === null) return null;
	const candidate = value as Partial<BrowserImportSummary>;
	if (candidate.sourceBrowser !== "chrome" && candidate.sourceBrowser !== "edge" && candidate.sourceBrowser !== "brave") {
		return null;
	}
	if (typeof candidate.sourceProfile !== "string" || candidate.sourceProfile.length === 0) return null;
	const importedBookmarks = candidate.importedBookmarks;
	const skippedBookmarks = candidate.skippedBookmarks;
	if (typeof importedBookmarks !== "number" || !Number.isSafeInteger(importedBookmarks) || importedBookmarks < 0) return null;
	if (typeof skippedBookmarks !== "number" || !Number.isSafeInteger(skippedBookmarks) || skippedBookmarks < 0) return null;
	if (typeof candidate.importedAt !== "string" || Number.isNaN(Date.parse(candidate.importedAt))) return null;
	return {
		sourceBrowser: candidate.sourceBrowser,
		sourceProfile: candidate.sourceProfile,
		importedBookmarks,
		skippedBookmarks,
		importedAt: candidate.importedAt,
	};
}

async function readJson(stateDir: string, fileName: string): Promise<unknown | null> {
	try {
		return JSON.parse(await readFile(path.join(stateDir, fileName), "utf8"));
	} catch {
		return null;
	}
}

async function writeJson(stateDir: string, fileName: string, value: unknown): Promise<void> {
	await mkdir(stateDir, { recursive: true, mode: 0o700 });
	const file = path.join(stateDir, fileName);
	const tmp = path.join(stateDir, `.${fileName}-${process.pid}-${Date.now()}.tmp`);
	await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	await rename(tmp, file);
}

export function createBrowserProfileStorage(
	options: BrowserProfileStorageOptions | (() => string) = {},
): BrowserProfileStorage {
	const { stateDir, randomId = randomUUID } =
		typeof options === "function" ? { randomId: options } : options;
	let selectedPersistence: BrowserProfilePersistence = DEFAULT_PERSISTENCE;
	let persistentDestinationActive = false;
	let operationQueue: Promise<unknown> = Promise.resolve();

	const runOperation = <T>(operation: () => Promise<T>): Promise<T> => {
		const queued = operationQueue.then(operation, operation);
		operationQueue = queued.then(
			() => undefined,
			() => undefined,
		);
		return queued;
	};

	return {
		partitionFor: (persistence = DEFAULT_PERSISTENCE) => {
			if (persistence === "persistent") {
				persistentDestinationActive = true;
				return AO_BROWSER_PERSISTENT_PARTITION;
			}
			return `${EPHEMERAL_PARTITION_PREFIX}${randomId()}`;
		},
		getPersistence: () => selectedPersistence,
		load: async () => {
			if (!stateDir) return selectedPersistence;
			return runOperation(async () => {
				const value = await readJson(stateDir, BROWSER_PROFILE_SETTINGS_FILE_NAME);
				selectedPersistence =
					typeof value === "object" && value !== null
						? coercePersistence((value as { persistence?: unknown }).persistence)
						: DEFAULT_PERSISTENCE;
				return selectedPersistence;
			});
		},
		selectPersistence: async (persistence) => {
			const next = coercePersistence(persistence);
			if (!stateDir) {
				selectedPersistence = next;
				return selectedPersistence;
			}
			return runOperation(async () => {
				await writeJson(stateDir, BROWSER_PROFILE_SETTINGS_FILE_NAME, { version: 1, persistence: next });
				selectedPersistence = next;
				return selectedPersistence;
			});
		},
		readImportSummary: async () => {
			if (!stateDir) return null;
			return runOperation(async () => coerceSummary(await readJson(stateDir, BROWSER_IMPORT_SUMMARY_FILE_NAME)));
		},
		writeImportSummary: async (summary) => {
			const next = coerceSummary(summary);
			if (!next) throw new Error("Invalid browser import summary");
			if (!stateDir) return next;
			return runOperation(async () => {
				await writeJson(stateDir, BROWSER_IMPORT_SUMMARY_FILE_NAME, next);
				return next;
			});
		},
		isPersistentDestinationActive: () => persistentDestinationActive,
	};
}
