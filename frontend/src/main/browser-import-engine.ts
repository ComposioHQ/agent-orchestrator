import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
	MAX_BOOKMARK_DEPTH as AO_MAX_BOOKMARK_DEPTH,
	MAX_BOOKMARK_NODES,
	MAX_BOOKMARK_OUTPUT_BYTES,
	MAX_BOOKMARK_URLS,
	type BrowserBookmarkNode,
	type BrowserBookmarkRoots,
} from "./browser-bookmark-store";
import type { BrowserImportBrowser } from "./browser-profile-storage";

export const BROWSER_IMPORT_DATA = ["bookmarks"] as const;
export const MAX_BOOKMARK_FILE_BYTES = 12 * 1024 * 1024;
export const MAX_IMPORTED_BOOKMARKS = MAX_BOOKMARK_URLS;
export const MAX_IMPORTED_NODES = MAX_BOOKMARK_NODES;
export const MAX_BOOKMARK_DEPTH = AO_MAX_BOOKMARK_DEPTH;
export { MAX_BOOKMARK_OUTPUT_BYTES };

const MAX_BOOKMARK_NAME_LENGTH = 1_024;
const MAX_BOOKMARK_URL_LENGTH = 4_096;
const PROFILE_DIRECTORY_PATTERN = /^(Default|Profile \d+)$/;

export type BrowserImportRoot = {
	browser: BrowserImportBrowser;
	label: string;
	path: string;
};

export type BrowserImportSource = {
	id: string;
	browser: BrowserImportBrowser;
	label: string;
	profileName: string;
	bookmarkCount: number;
};

export type BrowserImportScan = {
	sources: BrowserImportSource[];
	supportedData: typeof BROWSER_IMPORT_DATA;
};

export type BrowserImportResult = {
	sourceBrowser: BrowserImportBrowser;
	sourceProfile: string;
	importedBookmarks: number;
	skippedBookmarks: number;
	destination: "ao-persistent-browser";
};

export type BrowserImportPrepared = BrowserImportResult & {
	bookmarks: BrowserBookmarkRoots;
	sourceFingerprint: string;
};

export type BrowserImportEngineOptions = {
	homeDir: string;
	platform: NodeJS.Platform;
	roots?: readonly BrowserImportRoot[];
	randomId?: () => string;
	isDestinationActive?: () => boolean;
};

type RawBookmarkNode = {
	[key: string]: unknown;
	type?: unknown;
	name?: unknown;
	url?: unknown;
	children?: unknown;
};

export type NormalizedBookmarkFile = {
	roots: BrowserBookmarkRoots;
	version: 1;
};

type NormalizedChildren = {
	children: BrowserBookmarkNode[];
	importedBookmarks: number;
	skippedBookmarks: number;
};

type Candidate = {
	source: BrowserImportSource;
	rootPath: string;
	profilePath: string;
	bookmarksPath: string;
};

export class BrowserImportError extends Error {
	readonly code: "DESTINATION_ACTIVE" | "SOURCE_INVALID" | "SOURCE_NOT_FOUND" | "UNSUPPORTED_PLATFORM";

	constructor(code: BrowserImportError["code"], message: string) {
		super(message);
		this.name = "BrowserImportError";
		this.code = code;
	}
}

function isPathInside(parent: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(parent), path.resolve(candidate));
	return (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
	);
}

function defaultRoots(platform: NodeJS.Platform, homeDir: string): readonly BrowserImportRoot[] {
	if (platform === "win32") {
		return [
			{
				browser: "chrome",
				label: "Google Chrome",
				path: path.join(homeDir, "AppData", "Local", "Google", "Chrome", "User Data"),
			},
			{
				browser: "edge",
				label: "Microsoft Edge",
				path: path.join(homeDir, "AppData", "Local", "Microsoft", "Edge", "User Data"),
			},
			{
				browser: "brave",
				label: "Brave",
				path: path.join(homeDir, "AppData", "Local", "BraveSoftware", "Brave-Browser", "User Data"),
			},
		];
	}
	if (platform === "darwin") {
		return [
			{
				browser: "chrome",
				label: "Google Chrome",
				path: path.join(homeDir, "Library", "Application Support", "Google", "Chrome"),
			},
			{
				browser: "edge",
				label: "Microsoft Edge",
				path: path.join(homeDir, "Library", "Application Support", "Microsoft Edge"),
			},
			{
				browser: "brave",
				label: "Brave",
				path: path.join(homeDir, "Library", "Application Support", "BraveSoftware", "Brave-Browser"),
			},
		];
	}
	if (platform === "linux") {
		return [
			{ browser: "chrome", label: "Google Chrome", path: path.join(homeDir, ".config", "google-chrome") },
			{ browser: "edge", label: "Microsoft Edge", path: path.join(homeDir, ".config", "microsoft-edge") },
			{ browser: "brave", label: "Brave", path: path.join(homeDir, ".config", "BraveSoftware", "Brave-Browser") },
		];
	}
	return [];
}

function safeName(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, MAX_BOOKMARK_NAME_LENGTH);
	return cleaned || fallback;
}

function importableURL(value: unknown): string | null {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_BOOKMARK_URL_LENGTH) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		if (url.username || url.password || !url.hostname) return null;
		return value;
	} catch {
		return null;
	}
}

function rawNode(value: unknown): RawBookmarkNode | null {
	return typeof value === "object" && value !== null ? (value as RawBookmarkNode) : null;
}

function nodeId(randomId: () => string, nextId: number): string {
	const prefix = randomId().trim();
	return `${prefix || "ao-bookmark"}-${nextId}`.slice(0, 200);
}

function sourceFingerprint(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

export function normalizeBookmarks(
	value: unknown,
	options: { randomId?: () => string } = {},
): {
	file: NormalizedBookmarkFile;
	importedBookmarks: number;
	skippedBookmarks: number;
} | null {
	try {
		const root = rawNode(value);
		const roots = rawNode(root?.roots);
		if (!roots) return null;
		const bookmarkBar = rawNode(roots.bookmark_bar);
		const other = rawNode(roots.other);
		if (!bookmarkBar || !other || !Array.isArray(bookmarkBar.children) || !Array.isArray(other.children)) return null;

		const randomId = options.randomId ?? randomUUID;
		let nextId = 1;
		let nodeCount = 0;
		let urlCount = 0;
		let importedBookmarks = 0;
		let skippedBookmarks = 0;

		const countNode = (depth: number): void => {
			if (depth > MAX_BOOKMARK_DEPTH || ++nodeCount > MAX_BOOKMARK_NODES) throw new Error("bookmark limits exceeded");
		};

		const normalizeChildren = (children: unknown[], depth: number): NormalizedChildren => {
			const normalized: BrowserBookmarkNode[] = [];
			for (const child of children) {
				countNode(depth);
				const node = rawNode(child);
				if (!node) {
					skippedBookmarks += 1;
					continue;
				}
				const normalizedNode = makeNode(node, depth);
				if (normalizedNode) normalized.push(normalizedNode);
			}
			return { children: normalized, importedBookmarks, skippedBookmarks };
		};

		const makeNode = (node: RawBookmarkNode, depth: number): BrowserBookmarkNode | null => {
			const type = node.type;
			if (type === "url") {
				urlCount += 1;
				if (urlCount > MAX_BOOKMARK_URLS) throw new Error("bookmark URL limit exceeded");
				const url = importableURL(node.url);
				if (!url) {
					skippedBookmarks += 1;
					return null;
				}
				importedBookmarks += 1;
				return { type: "url", id: nodeId(randomId, nextId++), name: safeName(node.name, "Imported bookmark"), url };
			}
			if (type !== "folder" || !Array.isArray(node.children)) {
				skippedBookmarks += 1;
				return null;
			}
			return {
				type: "folder",
				id: nodeId(randomId, nextId++),
				name: safeName(node.name, "Imported folder"),
				children: normalizeChildren(node.children, depth + 1).children,
			};
		};

		const makeRoot = (source: RawBookmarkNode, fallback: string, children: unknown[]): Extract<BrowserBookmarkNode, { type: "folder" }> => {
			countNode(0);
			return {
				type: "folder",
				id: nodeId(randomId, nextId++),
				name: safeName(source.name, fallback),
				children: normalizeChildren(children, 1).children,
			};
		};

		const synced = rawNode(roots.synced);
		const syncedChildren = synced && Array.isArray(synced.children) ? synced.children : [];
		const normalizedRoots: BrowserBookmarkRoots = {
			bookmark_bar: makeRoot(bookmarkBar, "Bookmarks bar", bookmarkBar.children),
			other: makeRoot(other, "Other bookmarks", other.children),
			synced: makeRoot(synced ?? {}, "Mobile bookmarks", syncedChildren),
		};
		const file: NormalizedBookmarkFile = { roots: normalizedRoots, version: 1 };
		if (Buffer.byteLength(JSON.stringify(file), "utf8") > MAX_BOOKMARK_OUTPUT_BYTES) return null;
		return { file, importedBookmarks, skippedBookmarks };
	} catch {
		return null;
	}
}

async function readNormalizedBookmarks(
	bookmarksPath: string,
	options: { randomId: () => string },
): Promise<{ file: NormalizedBookmarkFile; importedBookmarks: number; skippedBookmarks: number; sourceFingerprint: string } | null> {
	try {
		// Preflight before readFile. The second check protects against a source file
		// growing between the metadata check and the read.
		const preflight = await lstat(bookmarksPath);
		if (!preflight.isFile() || preflight.isSymbolicLink() || preflight.size > MAX_BOOKMARK_FILE_BYTES) return null;
		const data = await readFile(bookmarksPath);
		if (data.byteLength > MAX_BOOKMARK_FILE_BYTES) return null;
		const value = JSON.parse(data.toString("utf8").replace(/^\uFEFF/, ""));
		const normalized = normalizeBookmarks(value, options);
		return normalized ? { ...normalized, sourceFingerprint: sourceFingerprint(data) } : null;
	} catch {
		return null;
	}
}

async function isSafeDirectory(directory: string, homeDir: string): Promise<boolean> {
	try {
		const stats = await lstat(directory);
		if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
		const [resolvedHome, resolvedDirectory] = await Promise.all([realpath(homeDir), realpath(directory)]);
		return isPathInside(resolvedHome, resolvedDirectory);
	} catch {
		return false;
	}
}

async function isSafeBookmarkFile(filePath: string, rootPath: string, homeDir: string): Promise<boolean> {
	try {
		const stats = await lstat(filePath);
		if (!stats.isFile() || stats.isSymbolicLink()) return false;
		const [resolvedHome, resolvedRoot, resolvedFile] = await Promise.all([realpath(homeDir), realpath(rootPath), realpath(filePath)]);
		return isPathInside(resolvedHome, resolvedRoot) && isPathInside(resolvedRoot, resolvedFile);
	} catch {
		return false;
	}
}

export function createBrowserImportEngine(options: BrowserImportEngineOptions) {
	const homeDir = path.resolve(options.homeDir);
	const roots = options.roots ?? defaultRoots(options.platform, homeDir);
	const randomId = options.randomId ?? randomUUID;
	const candidates = new Map<string, Candidate>();

	const detect = async (): Promise<BrowserImportScan> => {
		candidates.clear();
		const sources: BrowserImportSource[] = [];
		if (roots.length === 0 && options.platform !== "win32" && options.platform !== "darwin" && options.platform !== "linux") {
			return { sources, supportedData: BROWSER_IMPORT_DATA };
		}
		for (const root of roots) {
			const rootPath = path.resolve(root.path);
			if (!isPathInside(homeDir, rootPath) || !(await isSafeDirectory(rootPath, homeDir))) continue;
			let entries: import("node:fs").Dirent[];
			try {
				entries = await readdir(rootPath, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (!entry.isDirectory() || entry.isSymbolicLink() || !PROFILE_DIRECTORY_PATTERN.test(entry.name)) continue;
				const profilePath = path.join(rootPath, entry.name);
				if (!(await isSafeDirectory(profilePath, homeDir))) continue;
				const bookmarksPath = path.join(profilePath, "Bookmarks");
				if (!(await isSafeBookmarkFile(bookmarksPath, rootPath, homeDir))) continue;
				const normalized = await readNormalizedBookmarks(bookmarksPath, { randomId });
				if (!normalized) continue;
				let id = randomId();
				while (candidates.has(id)) id = randomId();
				const source: BrowserImportSource = {
					id,
					browser: root.browser,
					label: root.label,
					profileName: entry.name === "Default" ? "Default profile" : entry.name,
					bookmarkCount: normalized.importedBookmarks,
				};
				candidates.set(id, { source, rootPath, profilePath, bookmarksPath });
				sources.push(source);
			}
		}
		sources.sort((left, right) => `${left.label} ${left.profileName}`.localeCompare(`${right.label} ${right.profileName}`));
		return { sources, supportedData: BROWSER_IMPORT_DATA };
	};

	const importSource = async (sourceId: string): Promise<BrowserImportPrepared> => {
		if (options.isDestinationActive?.()) {
			throw new BrowserImportError("DESTINATION_ACTIVE", "The AO persistent browser is already active. Close its workers and try again.");
		}
		const candidate = candidates.get(sourceId);
		if (!candidate) throw new BrowserImportError("SOURCE_NOT_FOUND", "This browser source is no longer available. Scan again.");
		if (!(await isSafeDirectory(candidate.rootPath, homeDir)) || !(await isSafeDirectory(candidate.profilePath, homeDir))) {
			throw new BrowserImportError("SOURCE_INVALID", "The selected browser profile is no longer available.");
		}
		if (!(await isSafeBookmarkFile(candidate.bookmarksPath, candidate.rootPath, homeDir))) {
			throw new BrowserImportError("SOURCE_INVALID", "The selected browser bookmarks could not be read safely.");
		}
		const normalized = await readNormalizedBookmarks(candidate.bookmarksPath, { randomId });
		if (!normalized) throw new BrowserImportError("SOURCE_INVALID", "The selected browser bookmarks are not a supported format or exceed AO's import limits.");
		return {
			sourceBrowser: candidate.source.browser,
			sourceProfile: candidate.source.profileName,
			importedBookmarks: normalized.importedBookmarks,
			skippedBookmarks: normalized.skippedBookmarks,
			destination: "ao-persistent-browser",
			bookmarks: normalized.file.roots,
			sourceFingerprint: normalized.sourceFingerprint,
		};
	};

	return { detect, importSource };
}

export function browserImportRootsForPlatform(platform: NodeJS.Platform, homeDir: string): readonly BrowserImportRoot[] {
	return defaultRoots(platform, path.resolve(homeDir));
}
