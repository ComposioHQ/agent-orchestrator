import { randomUUID } from "node:crypto";

/**
 * The one AO-owned persistent browser destination. Electron stores data for a
 * persistent partition below its session-data directory; main.ts pins that
 * directory under ~/.ao before Electron is ready.
 */
export const AO_BROWSER_PERSISTENT_PARTITION = "persist:ao-browser";

const EPHEMERAL_PARTITION_PREFIX = "ao-browser-";

export type BrowserProfilePersistence = "ephemeral" | "persistent";

/**
 * Main-process-only seam for choosing the browser storage destination. The
 * persistent destination is deliberately singular; named profiles and source
 * browser storage do not belong in this layer.
 */
export type BrowserProfileStorage = {
	partitionFor: (persistence?: BrowserProfilePersistence) => string;
};

export function createBrowserProfileStorage(randomId: () => string = randomUUID): BrowserProfileStorage {
	return {
		partitionFor: (persistence = "ephemeral") =>
			persistence === "persistent" ? AO_BROWSER_PERSISTENT_PARTITION : `${EPHEMERAL_PARTITION_PREFIX}${randomId()}`,
	};
}
