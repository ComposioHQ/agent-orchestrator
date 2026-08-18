import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { BrowserImportBrowser } from "./browser-profile-storage";

export const BROWSER_IMPORT_DATA = ["bookmarks"] as const;
export const MAX_BOOKMARK_FILE_BYTES = 12 * 1024 * 1024;
export const MAX_IMPORTED_BOOKMARKS = 10_000;

const MAX_BOOKMARK_NAME_LENGTH = 1_024;
const MAX_BOOKMARK_URL_LENGTH = 4_096;
const MAX_BOOKMARK_DEPTH = 20;
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

export type BrowserImportEngineOptions = {
  homeDir: string;
  platform: NodeJS.Platform;
  aoDataRoot: string;
  destinationBookmarksPath: string;
  roots?: readonly BrowserImportRoot[];
  randomId?: () => string;
  now?: () => Date;
  isDestinationActive?: () => boolean;
};

type RawBookmarkNode = {
  [key: string]: unknown;
  type?: unknown;
  name?: unknown;
  url?: unknown;
  children?: unknown;
  date_added?: unknown;
  date_modified?: unknown;
};

type NormalizedBookmarkNode = {
  id: string;
  guid: string;
  name: string;
  date_added: string;
  type: "url" | "folder";
  url?: string;
  date_modified?: string;
  children?: NormalizedBookmarkNode[];
};

export type NormalizedBookmarkFile = {
  checksum: string;
  roots: {
    bookmark_bar: NormalizedBookmarkNode;
    other: NormalizedBookmarkNode;
    synced: NormalizedBookmarkNode;
  };
  version: 1;
};

type NormalizedChildren = {
  children: NormalizedBookmarkNode[];
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
  readonly code:
    | "DESTINATION_ACTIVE"
    | "DESTINATION_NOT_EMPTY"
    | "SOURCE_INVALID"
    | "SOURCE_NOT_FOUND"
    | "UNSUPPORTED_PLATFORM";

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
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function defaultRoots(
  platform: NodeJS.Platform,
  homeDir: string,
): readonly BrowserImportRoot[] {
  if (platform === "win32") {
    return [
      {
        browser: "chrome",
        label: "Google Chrome",
        path: path.join(
          homeDir,
          "AppData",
          "Local",
          "Google",
          "Chrome",
          "User Data",
        ),
      },
      {
        browser: "edge",
        label: "Microsoft Edge",
        path: path.join(
          homeDir,
          "AppData",
          "Local",
          "Microsoft",
          "Edge",
          "User Data",
        ),
      },
      {
        browser: "brave",
        label: "Brave",
        path: path.join(
          homeDir,
          "AppData",
          "Local",
          "BraveSoftware",
          "Brave-Browser",
          "User Data",
        ),
      },
    ];
  }
  if (platform === "darwin") {
    return [
      {
        browser: "chrome",
        label: "Google Chrome",
        path: path.join(
          homeDir,
          "Library",
          "Application Support",
          "Google",
          "Chrome",
        ),
      },
      {
        browser: "edge",
        label: "Microsoft Edge",
        path: path.join(
          homeDir,
          "Library",
          "Application Support",
          "Microsoft Edge",
        ),
      },
      {
        browser: "brave",
        label: "Brave",
        path: path.join(
          homeDir,
          "Library",
          "Application Support",
          "BraveSoftware",
          "Brave-Browser",
        ),
      },
    ];
  }
  if (platform === "linux") {
    return [
      {
        browser: "chrome",
        label: "Google Chrome",
        path: path.join(homeDir, ".config", "google-chrome"),
      },
      {
        browser: "edge",
        label: "Microsoft Edge",
        path: path.join(homeDir, ".config", "microsoft-edge"),
      },
      {
        browser: "brave",
        label: "Brave",
        path: path.join(homeDir, ".config", "BraveSoftware", "Brave-Browser"),
      },
    ];
  }
  return [];
}

function safeName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, MAX_BOOKMARK_NAME_LENGTH);
  return cleaned || fallback;
}

function chromeTimestamp(now: Date): string {
  return (BigInt(now.getTime()) * 1_000n + 11_644_473_600_000_000n).toString();
}

function safeTimestamp(value: unknown, now: Date): string {
  return typeof value === "string" && /^\d+$/.test(value)
    ? value
    : chromeTimestamp(now);
}

function importableURL(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_BOOKMARK_URL_LENGTH
  )
    return null;
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
  return typeof value === "object" && value !== null
    ? (value as RawBookmarkNode)
    : null;
}

function updateChecksum(
  hash: ReturnType<typeof createHash>,
  node: NormalizedBookmarkNode,
): void {
  hash.update(node.id, "utf8");
  hash.update(node.name, "utf16le");
  hash.update(node.type, "utf8");
  if (node.type === "url") {
    hash.update(node.url ?? "", "utf8");
    return;
  }
  for (const child of node.children ?? []) updateChecksum(hash, child);
}

function checksumFor(roots: NormalizedBookmarkFile["roots"]): string {
  const hash = createHash("md5");
  updateChecksum(hash, roots.bookmark_bar);
  updateChecksum(hash, roots.other);
  updateChecksum(hash, roots.synced);
  return hash.digest("hex").toUpperCase();
}

export function normalizeBookmarks(
  value: unknown,
  options: { randomId?: () => string; now?: () => Date } = {},
): {
  file: NormalizedBookmarkFile;
  importedBookmarks: number;
  skippedBookmarks: number;
} | null {
  const root = rawNode(value);
  const roots = rawNode(root?.roots);
  if (!roots) return null;
  const bookmarkBar = rawNode(roots.bookmark_bar);
  const other = rawNode(roots.other);
  if (
    !bookmarkBar ||
    !other ||
    !Array.isArray(bookmarkBar.children) ||
    !Array.isArray(other.children)
  )
    return null;

  const randomId = options.randomId ?? randomUUID;
  const now = options.now ?? (() => new Date());
  let nextId = 4;
  let importedBookmarks = 0;
  let skippedBookmarks = 0;

  const makeNode = (
    node: RawBookmarkNode,
    depth: number,
  ): NormalizedBookmarkNode | null => {
    if (depth > MAX_BOOKMARK_DEPTH) {
      skippedBookmarks += 1;
      return null;
    }
    const type = node.type;
    const date = now();
    if (type === "url") {
      const url = importableURL(node.url);
      if (!url || importedBookmarks >= MAX_IMPORTED_BOOKMARKS) {
        skippedBookmarks += 1;
        return null;
      }
      importedBookmarks += 1;
      return {
        id: String(nextId++),
        guid: randomId().replaceAll("-", "").slice(0, 32),
        name: safeName(node.name, "Imported bookmark"),
        date_added: safeTimestamp(node.date_added, date),
        type: "url",
        url,
      };
    }
    if (type !== "folder" || !Array.isArray(node.children)) {
      skippedBookmarks += 1;
      return null;
    }
    const children = normalizeChildren(node.children, depth + 1);
    return {
      id: String(nextId++),
      guid: randomId().replaceAll("-", "").slice(0, 32),
      name: safeName(node.name, "Imported folder"),
      date_added: safeTimestamp(node.date_added, date),
      date_modified: safeTimestamp(node.date_modified, date),
      type: "folder",
      children: children.children,
    };
  };

  const normalizeChildren = (
    children: unknown[],
    depth: number,
  ): NormalizedChildren => {
    const normalized: NormalizedBookmarkNode[] = [];
    for (const child of children) {
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

  // Chromium requires the two desktop roots and accepts the mobile root as an
  // optional third root. Use fresh IDs and GUIDs so importing never reuses
  // identity from the source profile.
  const makeRoot = (
    source: RawBookmarkNode,
    id: string,
    fallback: string,
    children: unknown[],
  ): NormalizedBookmarkNode => {
    const date = now();
    const normalized = normalizeChildren(children, 1);
    return {
      id,
      guid: randomId().replaceAll("-", "").slice(0, 32),
      name: safeName(source.name, fallback),
      date_added: safeTimestamp(source.date_added, date),
      date_modified: safeTimestamp(source.date_modified, date),
      type: "folder",
      children: normalized.children,
    };
  };

  const synced = rawNode(roots.synced);
  const syncedChildren =
    synced && Array.isArray(synced.children) ? synced.children : [];
  const normalizedRoots = {
    bookmark_bar: makeRoot(
      bookmarkBar,
      "1",
      "Bookmarks bar",
      bookmarkBar.children,
    ),
    other: makeRoot(other, "2", "Other bookmarks", other.children),
    synced: makeRoot(synced ?? {}, "3", "Mobile bookmarks", syncedChildren),
  };
  const file: NormalizedBookmarkFile = {
    checksum: checksumFor(normalizedRoots),
    roots: normalizedRoots,
    version: 1,
  };
  return { file, importedBookmarks, skippedBookmarks };
}

async function readNormalizedBookmarks(
  bookmarksPath: string,
  options: { randomId: () => string; now: () => Date },
): Promise<{
  file: NormalizedBookmarkFile;
  importedBookmarks: number;
  skippedBookmarks: number;
} | null> {
  try {
    const data = await readFile(bookmarksPath);
    if (data.byteLength > MAX_BOOKMARK_FILE_BYTES) return null;
    const value = JSON.parse(data.toString("utf8").replace(/^\uFEFF/, ""));
    return normalizeBookmarks(value, options);
  } catch {
    return null;
  }
}

async function isSafeDirectory(
  directory: string,
  homeDir: string,
): Promise<boolean> {
  try {
    const stats = await lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    const [resolvedHome, resolvedDirectory] = await Promise.all([
      realpath(homeDir),
      realpath(directory),
    ]);
    return isPathInside(resolvedHome, resolvedDirectory);
  } catch {
    return false;
  }
}

async function isSafeBookmarkFile(
  filePath: string,
  rootPath: string,
  homeDir: string,
): Promise<boolean> {
  try {
    const stats = await lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) return false;
    const [resolvedHome, resolvedRoot, resolvedFile] = await Promise.all([
      realpath(homeDir),
      realpath(rootPath),
      realpath(filePath),
    ]);
    return (
      isPathInside(resolvedHome, resolvedRoot) &&
      isPathInside(resolvedRoot, resolvedFile)
    );
  } catch {
    return false;
  }
}

export function createBrowserImportEngine(options: BrowserImportEngineOptions) {
  const homeDir = path.resolve(options.homeDir);
  const roots = options.roots ?? defaultRoots(options.platform, homeDir);
  const randomId = options.randomId ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const candidates = new Map<string, Candidate>();
  const destinationPath = path.resolve(options.destinationBookmarksPath);
  const aoDataRoot = path.resolve(options.aoDataRoot);

  const detect = async (): Promise<BrowserImportScan> => {
    candidates.clear();
    const sources: BrowserImportSource[] = [];
    if (roots.length === 0) {
      if (
        options.platform !== "win32" &&
        options.platform !== "darwin" &&
        options.platform !== "linux"
      ) {
        return { sources, supportedData: BROWSER_IMPORT_DATA };
      }
    }
    for (const root of roots) {
      const rootPath = path.resolve(root.path);
      if (
        !isPathInside(homeDir, rootPath) ||
        !(await isSafeDirectory(rootPath, homeDir))
      )
        continue;
      let entries: import("node:fs").Dirent[];
      try {
        entries = await readdir(rootPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (
          !entry.isDirectory() ||
          entry.isSymbolicLink() ||
          !PROFILE_DIRECTORY_PATTERN.test(entry.name)
        )
          continue;
        const profilePath = path.join(rootPath, entry.name);
        if (!(await isSafeDirectory(profilePath, homeDir))) continue;
        const bookmarksPath = path.join(profilePath, "Bookmarks");
        if (!(await isSafeBookmarkFile(bookmarksPath, rootPath, homeDir)))
          continue;
        const normalized = await readNormalizedBookmarks(bookmarksPath, {
          randomId,
          now,
        });
        if (!normalized) continue;
        let id = randomId();
        while (candidates.has(id)) id = randomId();
        const source: BrowserImportSource = {
          id,
          browser: root.browser,
          label: root.label,
          profileName:
            entry.name === "Default" ? "Default profile" : entry.name,
          bookmarkCount: normalized.importedBookmarks,
        };
        candidates.set(id, { source, rootPath, profilePath, bookmarksPath });
        sources.push(source);
      }
    }
    sources.sort((left, right) =>
      `${left.label} ${left.profileName}`.localeCompare(
        `${right.label} ${right.profileName}`,
      ),
    );
    return { sources, supportedData: BROWSER_IMPORT_DATA };
  };

  const importSource = async (
    sourceId: string,
  ): Promise<BrowserImportResult> => {
    if (options.isDestinationActive?.()) {
      throw new BrowserImportError(
        "DESTINATION_ACTIVE",
        "The AO persistent browser is already active. Close its workers and try again.",
      );
    }
    const candidate = candidates.get(sourceId);
    if (!candidate)
      throw new BrowserImportError(
        "SOURCE_NOT_FOUND",
        "This browser source is no longer available. Scan again.",
      );
    if (
      !(await isSafeDirectory(candidate.rootPath, homeDir)) ||
      !(await isSafeDirectory(candidate.profilePath, homeDir))
    ) {
      throw new BrowserImportError(
        "SOURCE_INVALID",
        "The selected browser profile is no longer available.",
      );
    }
    if (
      !(await isSafeBookmarkFile(
        candidate.bookmarksPath,
        candidate.rootPath,
        homeDir,
      ))
    ) {
      throw new BrowserImportError(
        "SOURCE_INVALID",
        "The selected browser bookmarks could not be read safely.",
      );
    }
    const normalized = await readNormalizedBookmarks(candidate.bookmarksPath, {
      randomId,
      now,
    });
    if (!normalized)
      throw new BrowserImportError(
        "SOURCE_INVALID",
        "The selected browser bookmarks are not a supported format.",
      );
    if (
      !isPathInside(aoDataRoot, destinationPath) ||
      path.basename(destinationPath) !== "Bookmarks"
    ) {
      throw new BrowserImportError(
        "DESTINATION_NOT_EMPTY",
        "AO's persistent browser destination is unavailable.",
      );
    }
    try {
      await lstat(destinationPath);
      throw new BrowserImportError(
        "DESTINATION_NOT_EMPTY",
        "AO's persistent browser destination already contains bookmarks.",
      );
    } catch (error) {
      if (error instanceof BrowserImportError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new BrowserImportError(
          "DESTINATION_NOT_EMPTY",
          "AO's persistent browser destination is unavailable.",
        );
      }
    }
    await mkdir(path.dirname(destinationPath), {
      recursive: true,
      mode: 0o700,
    });
    const destinationParent = await realpath(
      path.dirname(destinationPath),
    ).catch(() => null);
    if (!destinationParent || !isPathInside(aoDataRoot, destinationParent)) {
      throw new BrowserImportError(
        "DESTINATION_NOT_EMPTY",
        "AO's persistent browser destination is unavailable.",
      );
    }
    const tmp = path.join(
      path.dirname(destinationPath),
      `.Bookmarks-${process.pid}-${Date.now()}.tmp`,
    );
    try {
      await writeFile(tmp, `${JSON.stringify(normalized.file, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(tmp, destinationPath);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
    return {
      sourceBrowser: candidate.source.browser,
      sourceProfile: candidate.source.profileName,
      importedBookmarks: normalized.importedBookmarks,
      skippedBookmarks: normalized.skippedBookmarks,
      destination: "ao-persistent-browser",
    };
  };

  return { detect, importSource };
}

export function browserImportRootsForPlatform(
  platform: NodeJS.Platform,
  homeDir: string,
): readonly BrowserImportRoot[] {
  return defaultRoots(platform, path.resolve(homeDir));
}
