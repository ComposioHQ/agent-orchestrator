import { statfsSync } from "node:fs";

/**
 * Disk-space preflight for the updater (#3528).
 *
 * Squirrel.Mac's ShipIt extracts the update zip and stages copies under
 * /var/folders and ~/Library/Caches/<bundle-id>.ShipIt. With no space left,
 * extraction silently truncates and the install fails with a bogus
 * whether the missing file is whichever locale
 * directory falls off the end, e.g. af.lproj). This happens after the app has
 * quit, where no UI can report it. These checks make that failure mode visible
 * and actionable BEFORE the app hands control to ShipIt.
 *
 * Every check fails open: if statfs is unavailable or errors, the update
 * proceeds exactly as it did before.
 */

/** Download needs the ~110MB zip plus temp-file headroom. */
export const DOWNLOAD_RESERVE_BYTES = 250 * 1024 * 1024;

/**
 * Install needs room for extraction + staging + the old-bundle backup:
 * roughly 3x the extracted app size, ballpark 1.5GB (#3528).
 */
export const INSTALL_RESERVE_BYTES = 1.5 * 1024 * 1024 * 1024;

const GIB = 1024 * 1024 * 1024;

/** Free bytes on the volume containing `dir`; undefined when statfs fails (fail open). */
export function freeBytesOnVolume(dir: string): number | undefined {
	try {
		const stats = statfsSync(dir);
		const free = Number(stats.bavail) * Number(stats.bsize);
		return Number.isFinite(free) && free >= 0 ? free : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Smallest free-byte count across the volumes the update must touch; undefined
 * when every statfs failed (fail open). A volume whose statfs fails is skipped
 * rather than treated as full.
 */
export function minFreeBytes(dirs: string[]): number | undefined {
	let min: number | undefined;
	for (const dir of dirs) {
		const free = freeBytesOnVolume(dir);
		if (free === undefined) continue;
		min = min === undefined ? free : Math.min(min, free);
	}
	return min;
}

/** User-facing "free up N GB" figure, rounded up, minimum 1. */
export function gbRoundedUp(bytes: number): number {
	return Math.max(1, Math.ceil(bytes / GIB));
}
