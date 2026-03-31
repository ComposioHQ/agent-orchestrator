import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { InstalledPluginConfig, PluginModule, PluginSlot } from "@composio/ao-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Resolve registry from package root (works from both src/lib/ and dist/lib/)
const registryPath = resolve(__dirname, "../../src/assets/plugin-registry.json");
const registryData = JSON.parse(readFileSync(registryPath, "utf-8")) as unknown[];

export interface MarketplacePluginEntry {
  id: string;
  package: string;
  slot: PluginSlot;
  description: string;
  source: "registry";
  setupAction?: "openclaw-setup";
  latestVersion?: string;
}

export const BUNDLED_MARKETPLACE_PLUGIN_CATALOG = registryData as MarketplacePluginEntry[];
export const MARKETPLACE_PLUGIN_CATALOG = BUNDLED_MARKETPLACE_PLUGIN_CATALOG;
export const DEFAULT_REMOTE_MARKETPLACE_REGISTRY_URL =
  "https://raw.githubusercontent.com/ComposioHQ/agent-orchestrator/main/packages/cli/src/assets/plugin-registry.json";

const LOCAL_PLUGIN_ENTRY_CANDIDATES = ["dist/index.js", "index.js"] as const;
const MARKETPLACE_CACHE_FILE = "plugin-registry.json";

function isPluginSlot(value: unknown): value is PluginSlot {
  return (
    value === "runtime" ||
    value === "agent" ||
    value === "workspace" ||
    value === "tracker" ||
    value === "scm" ||
    value === "notifier" ||
    value === "terminal"
  );
}

function isMarketplacePluginEntry(value: unknown): value is MarketplacePluginEntry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MarketplacePluginEntry>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.package === "string" &&
    isPluginSlot(candidate.slot) &&
    typeof candidate.description === "string" &&
    candidate.source === "registry"
  );
}

function mergeMarketplaceCatalogs(
  primary: MarketplacePluginEntry[],
  fallback: MarketplacePluginEntry[],
): MarketplacePluginEntry[] {
  const merged = new Map<string, MarketplacePluginEntry>();
  for (const entry of fallback) {
    merged.set(entry.id, entry);
  }
  for (const entry of primary) {
    merged.set(entry.id, entry);
  }
  return [...merged.values()];
}

export function getMarketplaceRegistryCachePath(): string {
  const override = process.env["AO_PLUGIN_REGISTRY_CACHE_PATH"];
  if (override && override.trim().length > 0) {
    return override;
  }
  return join(homedir(), ".agent-orchestrator", MARKETPLACE_CACHE_FILE);
}

function validateMarketplaceCatalog(payload: unknown, sourceLabel: string): MarketplacePluginEntry[] {
  if (!Array.isArray(payload)) {
    throw new Error(`${sourceLabel} did not return a registry array.`);
  }

  const entries = payload.filter(isMarketplacePluginEntry);
  if (entries.length !== payload.length) {
    throw new Error(`${sourceLabel} returned invalid marketplace registry entries.`);
  }

  return entries;
}

function readMarketplaceCatalogFile(filePath: string): MarketplacePluginEntry[] | null {
  if (!existsSync(filePath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    return validateMarketplaceCatalog(parsed, filePath);
  } catch {
    return null;
  }
}

function writeMarketplaceCatalogCache(entries: MarketplacePluginEntry[]): void {
  const cachePath = getMarketplaceRegistryCachePath();
  mkdirSync(dirname(cachePath), { recursive: true });
  const tempPath = `${cachePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tempPath, `${JSON.stringify(entries, null, 2)}\n`, "utf-8");
  renameSync(tempPath, cachePath);
}

export function loadMarketplaceCatalog(): MarketplacePluginEntry[] {
  const cached = readMarketplaceCatalogFile(getMarketplaceRegistryCachePath());
  if (!cached) {
    return [...BUNDLED_MARKETPLACE_PLUGIN_CATALOG];
  }
  return mergeMarketplaceCatalogs(cached, BUNDLED_MARKETPLACE_PLUGIN_CATALOG);
}

export async function refreshMarketplaceCatalog(
  url = process.env["AO_PLUGIN_REGISTRY_URL"] ?? DEFAULT_REMOTE_MARKETPLACE_REGISTRY_URL,
): Promise<MarketplacePluginEntry[]> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch marketplace registry from ${url} (HTTP ${response.status}).`);
  }

  const parsed = (await response.json()) as unknown;
  const remoteEntries = validateMarketplaceCatalog(parsed, url);
  const mergedEntries = mergeMarketplaceCatalogs(remoteEntries, BUNDLED_MARKETPLACE_PLUGIN_CATALOG);
  writeMarketplaceCatalogCache(mergedEntries);
  return mergedEntries;
}

function isPluginModule(value: unknown): value is PluginModule {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PluginModule>;
  return Boolean(candidate.manifest && typeof candidate.create === "function");
}

export function normalizeImportedPluginModule(value: unknown): PluginModule | null {
  if (isPluginModule(value)) return value;
  if (value && typeof value === "object" && "default" in value) {
    const defaultExport = (value as { default?: unknown }).default;
    if (isPluginModule(defaultExport)) return defaultExport;
  }
  return null;
}

function resolvePackageExportsEntry(exportsField: unknown): string | null {
  if (typeof exportsField === "string") return exportsField;
  if (!exportsField || typeof exportsField !== "object") return null;

  const exportsRecord = exportsField as Record<string, unknown>;
  const dotEntry = exportsRecord["."];
  if (typeof dotEntry === "string") return dotEntry;
  if (dotEntry && typeof dotEntry === "object") {
    const importEntry = (dotEntry as Record<string, unknown>)["import"];
    if (typeof importEntry === "string") return importEntry;
    const defaultEntry = (dotEntry as Record<string, unknown>)["default"];
    if (typeof defaultEntry === "string") return defaultEntry;
  }

  const importEntry = exportsRecord["import"];
  if (typeof importEntry === "string") return importEntry;

  return null;
}

function resolveLocalPluginEntrypoint(pluginPath: string): string | null {
  if (!existsSync(pluginPath)) return null;

  const stat = statSync(pluginPath);
  if (stat.isFile()) return pluginPath;
  if (!stat.isDirectory()) return null;

  const packageJsonPath = join(pluginPath, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const raw = readFileSync(packageJsonPath, "utf-8");
      const packageJson = JSON.parse(raw) as { exports?: unknown; main?: unknown; module?: unknown };
      const exportsEntry = resolvePackageExportsEntry(packageJson.exports);
      if (exportsEntry) {
        const resolvedExportsEntry = resolve(pluginPath, exportsEntry);
        if (existsSync(resolvedExportsEntry)) return resolvedExportsEntry;
      }
      if (typeof packageJson.module === "string") {
        const moduleEntry = resolve(pluginPath, packageJson.module);
        if (existsSync(moduleEntry)) return moduleEntry;
      }
      if (typeof packageJson.main === "string") {
        const mainEntry = resolve(pluginPath, packageJson.main);
        if (existsSync(mainEntry)) return mainEntry;
      }
    } catch {
      // Fall through to common entrypoints below.
    }
  }

  for (const candidate of LOCAL_PLUGIN_ENTRY_CANDIDATES) {
    const entry = join(pluginPath, candidate);
    if (existsSync(entry)) return entry;
  }

  return null;
}

export function isLocalPluginReference(reference: string): boolean {
  return (
    reference.startsWith("./") ||
    reference.startsWith("../") ||
    reference.startsWith("/") ||
    reference.startsWith("~/") ||
    isAbsolute(reference)
  );
}

export function findMarketplacePlugin(reference: string): MarketplacePluginEntry | undefined {
  return loadMarketplaceCatalog().find(
    (plugin) => plugin.id === reference || plugin.package === reference,
  );
}

function expandHomePath(value: string): string {
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

function parseNpmPackageReference(reference: string): { packageName: string; version?: string } {
  if (reference.startsWith("@")) {
    const slashIndex = reference.indexOf("/");
    const versionSeparator = slashIndex >= 0 ? reference.indexOf("@", slashIndex + 1) : -1;
    if (versionSeparator > 0) {
      return {
        packageName: reference.slice(0, versionSeparator),
        version: reference.slice(versionSeparator + 1),
      };
    }
    return { packageName: reference };
  }

  const versionSeparator = reference.lastIndexOf("@");
  if (versionSeparator > 0) {
    return {
      packageName: reference.slice(0, versionSeparator),
      version: reference.slice(versionSeparator + 1),
    };
  }

  return { packageName: reference };
}

export function buildPluginDescriptor(
  reference: string,
  configPath: string,
): {
  descriptor: InstalledPluginConfig;
  specifier: string;
  setupAction?: MarketplacePluginEntry["setupAction"];
} {
  const marketplacePlugin = findMarketplacePlugin(reference);
  if (marketplacePlugin) {
    return {
      descriptor: {
        name: marketplacePlugin.id,
        source: marketplacePlugin.source,
        package: marketplacePlugin.package,
        version: marketplacePlugin.latestVersion,
        enabled: true,
      },
      specifier: marketplacePlugin.package,
      setupAction: marketplacePlugin.setupAction,
    };
  }

  if (isLocalPluginReference(reference)) {
    const expandedReference = expandHomePath(reference);
    const absolutePath = isAbsolute(expandedReference)
      ? expandedReference
      : resolve(dirname(configPath), expandedReference);
    const entrypoint = resolveLocalPluginEntrypoint(absolutePath);
    if (!entrypoint) {
      throw new Error(`Could not resolve a plugin entrypoint from ${reference}`);
    }

    return {
      descriptor: {
        name: reference,
        source: "local",
        path: reference,
        enabled: true,
      },
      specifier: pathToFileURL(entrypoint).href,
    };
  }

  const { packageName, version } = parseNpmPackageReference(reference);

  return {
    descriptor: {
      name: reference,
      source: "npm",
      package: packageName,
      version,
      enabled: true,
    },
    specifier: packageName,
  };
}
