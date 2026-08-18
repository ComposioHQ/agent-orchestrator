import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
	BrowserImportBrowser,
	BrowserImportSummary,
} from "./browser-profile-storage";

export const AO_BROWSER_BOOKMARKS_FILE_NAME = "browser-bookmarks.json";
export const AO_BROWSER_BOOKMARKS_VERSION = 1 as const;
export const MAX_BOOKMARK_NODES = 20_000;
export const MAX_BOOKMARK_URLS = 10_000;
export const MAX_BOOKMARK_DEPTH = 20;
export const MAX_BOOKMARK_OUTPUT_BYTES = 8 * 1024 * 1024;

export type BrowserBookmarkNode =
	| {
			type: "url";
			id: string;
			name: string;
			url: string;
		}
	| {
			type: "folder";
			id: string;
			name: string;
			children: BrowserBookmarkNode[];
		};

export type BrowserBookmarkRoots = {
	bookmark_bar: Extract<BrowserBookmarkNode, { type: "folder" }>;
	other: Extract<BrowserBookmarkNode, { type: "folder" }>;
	synced: Extract<BrowserBookmarkNode, { type: "folder" }>;
};

export type BrowserBookmarkDocument = {
	version: typeof AO_BROWSER_BOOKMARKS_VERSION;
	source: {
		browser: BrowserImportBrowser;
		profile: string;
		fingerprint: string;
	};
	importedAt: string;
	importedBookmarks: number;
	skippedBookmarks: number;
	roots: BrowserBookmarkRoots;
};

/** The renderer receives only the bookmark tree, never source paths or metadata. */
export type BrowserBookmarkView = {
	version: typeof AO_BROWSER_BOOKMARKS_VERSION;
	roots: BrowserBookmarkRoots;
};

export type BrowserBookmarkStorageOptions = {
	stateDir: string;
};

export type BrowserBookmarkWriteResult = {
	created: boolean;
	document: BrowserBookmarkDocument;
};

export type BrowserBookmarkStorage = {
	read: () => Promise<BrowserBookmarkDocument | null>;
	write: (document: BrowserBookmarkDocument) => Promise<BrowserBookmarkWriteResult>;
	removeIfMatches: (document: BrowserBookmarkDocument) => Promise<void>;
};

export class BrowserBookmarkStoreError extends Error {
	readonly code: "DESTINATION_NOT_EMPTY" | "STORE_INVALID";

	constructor(code: BrowserBookmarkStoreError["code"], message: string) {
		super(message);
		this.name = "BrowserBookmarkStoreError";
		this.code = code;
	}
}

function importableURL(value: unknown): string | null {
	if (typeof value !== "string" || value.length === 0 || value.length > 4_096) return null;
	try {
		const url = new URL(value);
		if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !url.hostname) {
			return null;
		}
		return value;
	} catch {
		return null;
	}
}

function validDocument(value: unknown): BrowserBookmarkDocument | null {
	if (typeof value !== "object" || value === null) return null;
	const candidate = value as Partial<BrowserBookmarkDocument>;
	if (candidate.version !== AO_BROWSER_BOOKMARKS_VERSION) return null;
	if (typeof candidate.importedAt !== "string" || Number.isNaN(Date.parse(candidate.importedAt))) return null;
	if (
		typeof candidate.importedBookmarks !== "number" ||
		!Number.isSafeInteger(candidate.importedBookmarks) ||
		candidate.importedBookmarks < 0 ||
		candidate.importedBookmarks > MAX_BOOKMARK_URLS
	) return null;
	if (
		typeof candidate.skippedBookmarks !== "number" ||
		!Number.isSafeInteger(candidate.skippedBookmarks) ||
		candidate.skippedBookmarks < 0
	) return null;
	const source = candidate.source;
	if (typeof source !== "object" || source === null) return null;
	if (source.browser !== "chrome" && source.browser !== "edge" && source.browser !== "brave") return null;
	if (typeof source.profile !== "string" || source.profile.length === 0 || source.profile.length > 256) return null;
	if (typeof source.fingerprint !== "string" || !/^[a-f\d]{64}$/i.test(source.fingerprint)) return null;
	const roots = candidate.roots;
	if (typeof roots !== "object" || roots === null) return null;
	const state = { nodes: 0, urls: 0 };
	const bookmarkBar = validNode((roots as Partial<BrowserBookmarkRoots>).bookmark_bar, 0, state);
	const other = validNode((roots as Partial<BrowserBookmarkRoots>).other, 0, state);
	const synced = validNode((roots as Partial<BrowserBookmarkRoots>).synced, 0, state);
	if (!bookmarkBar || bookmarkBar.type !== "folder" || !other || other.type !== "folder" || !synced || synced.type !== "folder") {
		return null;
	}
	return {
		version: AO_BROWSER_BOOKMARKS_VERSION,
		source: {
			browser: source.browser,
			profile: source.profile,
			fingerprint: source.fingerprint,
		},
		importedAt: candidate.importedAt,
		importedBookmarks: candidate.importedBookmarks,
		skippedBookmarks: candidate.skippedBookmarks,
		roots: { bookmark_bar: bookmarkBar, other, synced },
	};
}

function validNode(
	value: unknown,
	depth: number,
	state: { nodes: number; urls: number },
): BrowserBookmarkNode | null {
	if (depth > MAX_BOOKMARK_DEPTH || state.nodes >= MAX_BOOKMARK_NODES) return null;
	if (typeof value !== "object" || value === null) return null;
	const candidate = value as Partial<BrowserBookmarkNode>;
	if (typeof candidate.id !== "string" || candidate.id.length === 0 || candidate.id.length > 200) return null;
	if (typeof candidate.name !== "string" || candidate.name.length > 1_024) return null;
	state.nodes += 1;
	if (candidate.type === "url") {
		if (state.urls >= MAX_BOOKMARK_URLS) return null;
		const url = importableURL(candidate.url);
		if (!url) return null;
		state.urls += 1;
		return { type: "url", id: candidate.id, name: candidate.name, url };
	}
	if (candidate.type !== "folder" || !Array.isArray(candidate.children)) return null;
	const children: BrowserBookmarkNode[] = [];
	for (const child of candidate.children) {
		const normalized = validNode(child, depth + 1, state);
		if (!normalized) return null;
		children.push(normalized);
	}
	return { type: "folder", id: candidate.id, name: candidate.name, children };
}

function sameSource(left: BrowserBookmarkDocument, right: BrowserBookmarkDocument): boolean {
	return (
		left.source.browser === right.source.browser &&
		left.source.profile === right.source.profile &&
		left.source.fingerprint === right.source.fingerprint
	);
}

function summaryFromDocument(document: BrowserBookmarkDocument): BrowserImportSummary {
	return {
		sourceBrowser: document.source.browser,
		sourceProfile: document.source.profile,
		importedBookmarks: document.importedBookmarks,
		skippedBookmarks: document.skippedBookmarks,
		importedAt: document.importedAt,
	};
}

export function browserBookmarkView(document: BrowserBookmarkDocument): BrowserBookmarkView {
	return { version: document.version, roots: document.roots };
}

export function browserBookmarkSummary(document: BrowserBookmarkDocument | null): BrowserImportSummary | null {
	return document ? summaryFromDocument(document) : null;
}

export function validateBrowserBookmarkDocument(document: BrowserBookmarkDocument): void {
	if (!validDocument(document)) throw new BrowserBookmarkStoreError("STORE_INVALID", "AO bookmark data is invalid");
	const serialized = JSON.stringify(document);
	if (Buffer.byteLength(serialized, "utf8") > MAX_BOOKMARK_OUTPUT_BYTES) {
		throw new BrowserBookmarkStoreError("STORE_INVALID", "AO bookmark data is too large");
	}
}

async function readExisting(file: string): Promise<{ exists: boolean; document: BrowserBookmarkDocument | null }> {
	try {
		const preflight = await lstat(file);
		if (!preflight.isFile() || preflight.isSymbolicLink() || preflight.size > MAX_BOOKMARK_OUTPUT_BYTES) {
			return { exists: true, document: null };
		}
		const data = await readFile(file);
		if (data.byteLength > MAX_BOOKMARK_OUTPUT_BYTES) return { exists: true, document: null };
		const value = JSON.parse(data.toString("utf8")) as unknown;
		return { exists: true, document: validDocument(value) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, document: null };
		return { exists: true, document: null };
	}
}

export function createBrowserBookmarkStorage(options: BrowserBookmarkStorageOptions): BrowserBookmarkStorage {
	const stateDir = path.resolve(options.stateDir);
	const file = path.join(stateDir, AO_BROWSER_BOOKMARKS_FILE_NAME);
	let operationQueue: Promise<unknown> = Promise.resolve();
	const runOperation = <T>(operation: () => Promise<T>): Promise<T> => {
		const queued = operationQueue.then(operation, operation);
		operationQueue = queued.then(() => undefined, () => undefined);
		return queued;
	};

	return {
		read: () => runOperation(async () => (await readExisting(file)).document),
		write: (document) =>
			runOperation(async () => {
				validateBrowserBookmarkDocument(document);
				const existing = await readExisting(file);
				if (existing.exists) {
					if (existing.document && sameSource(existing.document, document)) {
						return { created: false, document: existing.document };
					}
					throw new BrowserBookmarkStoreError(
						"DESTINATION_NOT_EMPTY",
						"AO already has imported bookmarks. Use the existing bookmark set or remove it before importing another source.",
					);
				}
				await mkdir(stateDir, { recursive: true, mode: 0o700 });
				const tmp = path.join(stateDir, `.${AO_BROWSER_BOOKMARKS_FILE_NAME}-${process.pid}-${randomUUID()}.tmp`);
				try {
					await writeFile(tmp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
					await rename(tmp, file);
					return { created: true, document };
				} catch (error) {
					await rm(tmp, { force: true }).catch(() => undefined);
					throw error;
				}
			}),
		removeIfMatches: (document) =>
			runOperation(async () => {
				const existing = await readExisting(file);
				if (existing.document && sameSource(existing.document, document)) await rm(file, { force: true });
			}),
	};
}
