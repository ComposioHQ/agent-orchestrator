import { describe, expect, it } from "vitest";
import {
	CONTROL_PATH_MAX_BYTES,
	controlPath,
	controlPathFits,
	remoteCommandArgv,
	shellQuote,
	sshControlFlags,
	tunnelArgv,
} from "./ssh-command";

const control = { path: "/home/u/.ao/ssh/m-deadbeef" };

describe("sshControlFlags", () => {
	// Asserted verbatim: each flag is load-bearing and the order is part of the
	// contract these tests exist to pin.
	it("emits the full multiplexed block in fixed order", () => {
		expect(sshControlFlags(control)).toEqual([
			"-o",
			"ControlMaster=auto",
			"-o",
			"ControlPath=/home/u/.ao/ssh/m-deadbeef",
			"-o",
			"ControlPersist=60",
			"-o",
			"ConnectTimeout=5",
			"-o",
			"BatchMode=yes",
			"-o",
			"ServerAliveInterval=15",
			"-o",
			"ServerAliveCountMax=3",
			"-o",
			"LogLevel=ERROR",
		]);
	});

	it("omits only the ControlMaster options when unmultiplexed", () => {
		expect(sshControlFlags(null)).toEqual(sshControlFlags(control).slice(6));
	});

	// BatchMode is what turns an unknown host key into an immediate failure
	// instead of an unanswerable prompt on a tty-less supervisor.
	it("always sets BatchMode", () => {
		expect(sshControlFlags(null)).toContain("BatchMode=yes");
	});

	// Setting this at all is the bypass the design refuses.
	it("never sets StrictHostKeyChecking", () => {
		expect(sshControlFlags(control).join(" ")).not.toContain("StrictHostKeyChecking");
	});
});

describe("controlPath", () => {
	it("is stable and fixed-width per target", () => {
		const first = controlPath("/home/u/.ao/ssh", "build-vm");
		expect(first).toBe(controlPath("/home/u/.ao/ssh/", "build-vm"));
		expect(first).toMatch(/^\/home\/u\/\.ao\/ssh\/m-[0-9a-f]{8}$/);
	});

	it("distinguishes targets", () => {
		expect(controlPath("/d", "a")).not.toBe(controlPath("/d", "b"));
	});

	it("measures the sockaddr_un budget in bytes, not characters", () => {
		const nonAscii = `/${"é".repeat(CONTROL_PATH_MAX_BYTES - 10)}`;
		expect(nonAscii.length).toBeLessThan(CONTROL_PATH_MAX_BYTES);
		expect(controlPathFits(controlPath(nonAscii, "vm"))).toBe(false);
		expect(controlPathFits(controlPath("/tmp", "vm"))).toBe(true);
	});
});

describe("tunnelArgv", () => {
	it("forwards a local port to the remote loopback and runs no remote command", () => {
		expect(tunnelArgv({ sshTarget: "build-vm", control, localPort: 51234, remotePort: 3001 })).toEqual([
			...sshControlFlags(control),
			"-N",
			"-L",
			"51234:127.0.0.1:3001",
			"build-vm",
		]);
	});

	// The remote daemon binds 127.0.0.1; a remote resolver that maps `localhost`
	// to ::1 first would have the forward refused.
	it("targets 127.0.0.1 rather than localhost", () => {
		const argv = tunnelArgv({ sshTarget: "vm", control: null, localPort: 1, remotePort: 2 });
		expect(argv).toContain("1:127.0.0.1:2");
		expect(argv.join(" ")).not.toContain("localhost");
	});

	it("puts the target last so nothing can be read as a flag to it", () => {
		expect(tunnelArgv({ sshTarget: "vm", control, localPort: 1, remotePort: 2 }).at(-1)).toBe("vm");
	});
});

describe("remoteCommandArgv", () => {
	// sshd runs a remote command with the account's login shell; fish and csh do
	// not parse POSIX scripts, so /bin/sh is interposed unconditionally.
	it("always interposes /bin/sh -c", () => {
		expect(remoteCommandArgv({ sshTarget: "vm", control, script: "ao daemon" })).toEqual([
			...sshControlFlags(control),
			"vm",
			"/bin/sh",
			"-c",
			"ao daemon",
		]);
	});

	it("passes the script as one argv element, so no local shell is involved", () => {
		const argv = remoteCommandArgv({ sshTarget: "vm", control: null, script: "a; b && c > /dev/null" });
		expect(argv.at(-1)).toBe("a; b && c > /dev/null");
	});
});

describe("shellQuote", () => {
	it.each([
		["plain", "'plain'"],
		["with space", "'with space'"],
		["$HOME", "'$HOME'"],
		["`id`", "'`id`'"],
		["a'b", `'a'\\''b'`],
	])("quotes %j", (input, expected) => {
		expect(shellQuote(input)).toBe(expected);
	});

	// The three-layer case: a workspace path containing a space, a quote and a
	// dollar sign, interpolated into a script that ssh hands to /bin/sh.
	it("survives interpolation into a remote script", () => {
		const script = `cd -- ${shellQuote(`/home/u/it's $HOME dir`)} && pwd -P`;
		expect(script).toBe(`cd -- '/home/u/it'\\''s $HOME dir' && pwd -P`);
	});
});
