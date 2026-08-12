// Reading Host aliases out of the user's ~/.ssh/config.
//
// A workspace's target is "whatever you would type after `ssh`", and for most
// people that is an alias they already maintain. Offering those aliases makes
// the common case a click instead of a retyped hostname, and an alias is the
// better answer anyway: it carries ProxyJump, User, Port and IdentityFile with
// it, none of which AO wants to model.
//
// Pure and node:*-free (see daemon-attach.ts); the Electron main process owns
// the file reads and Include resolution.

/**
 * A Host alias, with the HostName it resolves to when the config states one.
 * `hostName` is shown as secondary text so two similar aliases can be told
 * apart; it is never what AO connects to — the alias is, so the user's own
 * config keeps governing.
 */
export type SshConfigHost = {
	alias: string;
	hostName?: string;
};

/**
 * Parse Host aliases from one ssh_config file.
 *
 * Deliberately shallow: it reads `Host` and `HostName` and ignores everything
 * else. This is a convenience list for a picker, not a config interpreter — ssh
 * itself remains the only thing that resolves a target, so being incomplete
 * here costs the user a manual entry, never a wrong connection.
 *
 * Returns `Include` paths separately, because resolving them needs the
 * filesystem and this module stays pure.
 */
export function parseSshConfig(text: string): { hosts: SshConfigHost[]; includes: string[] } {
	const hosts: SshConfigHost[] = [];
	const includes: string[] = [];
	// Aliases declared on the current `Host` line, so a following HostName can
	// be attached to all of them (`Host a b` is legal and means both).
	let current: SshConfigHost[] = [];

	for (const rawLine of text.split("\n")) {
		// Comments run to end of line; a keyword may be separated from its
		// arguments by whitespace or by `=`.
		const line = rawLine.replace(/#.*$/, "").trim();
		if (line === "") continue;
		const match = /^(\w+)[\s=]+(.+)$/.exec(line);
		if (!match) continue;
		const keyword = match[1].toLowerCase();
		const value = match[2].trim();

		if (keyword === "host") {
			current = [];
			for (const alias of value.split(/\s+/)) {
				// Patterns and negations match hosts, they do not name one, so there
				// is nothing to connect to. `Host *` is the usual example.
				if (alias === "" || /[*?!]/.test(alias)) continue;
				const host = { alias };
				current.push(host);
				hosts.push(host);
			}
		} else if (keyword === "hostname") {
			for (const host of current) host.hostName = value;
		} else if (keyword === "include") {
			// Include takes one or more (possibly quoted, possibly globbed) paths.
			for (const token of value.split(/\s+/)) {
				const cleaned = token.replace(/^["']|["']$/g, "");
				if (cleaned !== "") includes.push(cleaned);
			}
		}
	}

	return { hosts, includes };
}

/** Merge host lists from several files, keeping the first definition of an alias. */
export function dedupeSshHosts(lists: SshConfigHost[][]): SshConfigHost[] {
	const seen = new Set<string>();
	const merged: SshConfigHost[] = [];
	for (const list of lists) {
		for (const host of list) {
			if (seen.has(host.alias)) continue;
			seen.add(host.alias);
			merged.push(host);
		}
	}
	return merged;
}

/**
 * Suggest a workspace id for an alias: the registry's id rules are stricter
 * than ssh's alias rules, so `Build_VM.local` has to become `build-vm-local`.
 * Returns "" when nothing usable survives, and the user names it themselves.
 */
export function workspaceIdFromAlias(alias: string): string {
	return alias
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32)
		.replace(/-+$/, "");
}
