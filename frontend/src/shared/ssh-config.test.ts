import { describe, expect, it } from "vitest";
import { dedupeSshHosts, parseSshConfig, workspaceIdFromAlias } from "./ssh-config";

describe("parseSshConfig", () => {
	it("reads aliases and their HostName", () => {
		const { hosts } = parseSshConfig(`
Host build-vm
  HostName 10.0.0.5
  User deepak

Host gpu
  HostName gpu.internal
`);
		expect(hosts).toEqual([
			{ alias: "build-vm", hostName: "10.0.0.5" },
			{ alias: "gpu", hostName: "gpu.internal" },
		]);
	});

	// `Host a b` declares both, and a following HostName applies to both.
	it("handles several aliases on one Host line", () => {
		const { hosts } = parseSshConfig("Host vm1 vm1.local\n  HostName 10.0.0.9");
		expect(hosts).toEqual([
			{ alias: "vm1", hostName: "10.0.0.9" },
			{ alias: "vm1.local", hostName: "10.0.0.9" },
		]);
	});

	// Patterns match hosts, they do not name one — there is nothing to connect to.
	it.each(["*", "*.internal", "prod-?", "!staging"])("skips the pattern %j", (pattern) => {
		expect(parseSshConfig(`Host ${pattern}\n  User root`).hosts).toEqual([]);
	});

	it("ignores comments and blank lines", () => {
		const { hosts } = parseSshConfig("# Host commented\n\n  Host real # trailing\n");
		expect(hosts).toEqual([{ alias: "real" }]);
	});

	it("accepts the `Key=value` form and is case-insensitive on keywords", () => {
		const { hosts } = parseSshConfig("HOST=vm\n  hostname=example.com");
		expect(hosts).toEqual([{ alias: "vm", hostName: "example.com" }]);
	});

	it("collects Include paths for the caller to resolve", () => {
		const { includes } = parseSshConfig('Include config.d/*\nInclude "~/other/conf"\nHost vm');
		expect(includes).toEqual(["config.d/*", "~/other/conf"]);
	});

	it("returns nothing for an empty or junk file rather than throwing", () => {
		expect(parseSshConfig("")).toEqual({ hosts: [], includes: [] });
		expect(parseSshConfig("!!! not a config")).toEqual({ hosts: [], includes: [] });
	});
});

describe("dedupeSshHosts", () => {
	// ssh itself takes the first value it sees for a host, so the picker agrees.
	it("keeps the first definition of an alias", () => {
		expect(
			dedupeSshHosts([
				[{ alias: "vm", hostName: "first" }],
				[{ alias: "vm", hostName: "second" }, { alias: "other" }],
			]),
		).toEqual([{ alias: "vm", hostName: "first" }, { alias: "other" }]);
	});
});

describe("workspaceIdFromAlias", () => {
	// Registry ids are stricter than ssh aliases, so the suggestion has to be
	// coerced or the form would open pre-filled with something invalid.
	it.each([
		["build-vm", "build-vm"],
		["Build_VM.local", "build-vm-local"],
		["ssh.deepaksilaych.me", "ssh-deepaksilaych-me"],
		["--weird--", "weird"],
		["!!!", ""],
	])("suggests %j -> %j", (alias, expected) => {
		expect(workspaceIdFromAlias(alias)).toBe(expected);
	});

	it("stays within the id length limit and never ends in a dash", () => {
		const id = workspaceIdFromAlias(`${"a".repeat(30)}.${"b".repeat(30)}`);
		expect(id.length).toBeLessThanOrEqual(32);
		expect(id).not.toMatch(/-$/);
	});
});
