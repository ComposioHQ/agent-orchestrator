import { statSync } from "node:fs";
import path from "node:path";

// Windows/Linux: dropping a folder onto the app's taskbar icon or a desktop/
// Start-menu shortcut launches (or, if already running, re-signals) the app
// with the folder's path as a plain positional argv entry — unlike every
// other argument this app's own launchers pass (--installed-via=, the
// ao-app:// deep link, Electron/Chromium's own --flags). A real directory is
// a reliable signal: nothing else ever present in this app's argv resolves
// to one, so the first argv entry that does is the dropped folder.
export function parseOpenFolderPathArg(argv: string[]): string | undefined {
	for (const entry of argv) {
		if (entry.startsWith("-") || entry.includes("://")) continue;
		try {
			if (statSync(path.resolve(entry)).isDirectory()) return path.resolve(entry);
		} catch {
			// Not a real filesystem path — true of most argv entries (script paths,
			// the electron executable itself, flags already skipped above).
		}
	}
	return undefined;
}
