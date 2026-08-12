import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { dedupeSshHosts, parseSshConfig, type SshConfigHost } from "../shared/ssh-config";

/** Depth cap for Include chains: ssh allows nesting, and a cycle must not hang the UI. */
const MAX_INCLUDE_DEPTH = 4;
/** Upper bound on files read, so a pathological glob cannot stall the picker. */
const MAX_FILES = 64;

/**
 * Expand one Include path. ssh resolves a relative Include against ~/.ssh, and
 * supports globs, which are common in the `Include config.d/*` idiom.
 *
 * Only a trailing `*` is expanded — the case people actually write. Anything
 * fancier is skipped rather than half-supported, because this list is a
 * convenience and ssh remains the authority on what a target resolves to.
 */
async function expandInclude(pattern: string, homeDir: string): Promise<string[]> {
	const absolute = pattern.startsWith("~/")
		? path.join(homeDir, pattern.slice(2))
		: path.isAbsolute(pattern)
			? pattern
			: path.join(homeDir, ".ssh", pattern);

	if (!absolute.includes("*")) return [absolute];

	const dir = path.dirname(absolute);
	const base = path.basename(absolute);
	if (base.indexOf("*") !== base.length - 1) return [];
	const prefix = base.slice(0, -1);
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
			.map((entry) => path.join(dir, entry.name));
	} catch {
		return [];
	}
}

/**
 * Read the user's ssh_config Host aliases, following Include directives.
 *
 * Never throws: an absent, unreadable or malformed config means the picker
 * shows nothing and the user types a target by hand, which is exactly the
 * behaviour without this feature. It is read-only — AO does not write
 * ssh_config, the same way it does not write known_hosts.
 */
export async function readSshConfigHosts(homeDir: string): Promise<SshConfigHost[]> {
	const visited = new Set<string>();
	const lists: SshConfigHost[][] = [];

	const walk = async (file: string, depth: number): Promise<void> => {
		if (depth > MAX_INCLUDE_DEPTH || visited.size >= MAX_FILES || visited.has(file)) return;
		visited.add(file);

		let text: string;
		try {
			text = await readFile(file, "utf8");
		} catch {
			return;
		}

		const { hosts, includes } = parseSshConfig(text);
		lists.push(hosts);
		for (const include of includes) {
			for (const resolved of await expandInclude(include, homeDir)) {
				await walk(resolved, depth + 1);
			}
		}
	};

	await walk(path.join(homeDir, ".ssh", "config"), 0);
	return dedupeSshHosts(lists);
}
