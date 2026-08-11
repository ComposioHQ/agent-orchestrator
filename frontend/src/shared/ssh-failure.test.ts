import { describe, expect, it } from "vitest";
import { classifySshFailure, SSH_TRANSPORT_EXIT_CODE } from "./ssh-failure";

const classify = (code: number | null, stderr: string) => classifySshFailure(code, stderr, "build-vm");

describe("classifySshFailure", () => {
	// OpenSSH exits 255 for its own failures and otherwise forwards the remote
	// status. Getting this split wrong reports a broken tunnel as a dead daemon.
	it("attributes a non-255 exit to the remote command", () => {
		expect(classify(127, "").kind).toBe("remote_command_failed");
		expect(classify(1, "").message).toContain("exited with status 1");
	});

	it("treats death by signal as a transport failure, not a remote one", () => {
		expect(classify(null, "").kind).toBe("unreachable");
	});

	// A changed key also prints "Host key verification failed", so the louder,
	// security-relevant case has to be tested first or it is masked.
	it("distinguishes a changed host key from an unknown one", () => {
		const changed = classify(
			SSH_TRANSPORT_EXIT_CODE,
			"@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.",
		);
		expect(changed.kind).toBe("host_key_changed");
		// Never offer to fix it for them: the remedy is theirs to verify.
		expect(changed.message).toContain("remove the old entry");

		const unknown = classify(SSH_TRANSPORT_EXIT_CODE, "No ED25519 host key is known for build-vm.");
		expect(unknown.kind).toBe("host_key_unverified");
	});

	it.each([
		"Permission denied (publickey).",
		"Too many authentication failures",
		"deepak@build-vm: Permission denied (publickey,password).",
	])("classifies %j as an auth failure", (stderr) => {
		expect(classify(SSH_TRANSPORT_EXIT_CODE, stderr).kind).toBe("auth_failed");
	});

	it.each(["ssh: connect to host build-vm port 22: Connection refused", "ssh: Could not resolve hostname build-vm", ""])(
		"falls back to unreachable for %j",
		(stderr) => {
			expect(classify(SSH_TRANSPORT_EXIT_CODE, stderr).kind).toBe("unreachable");
		},
	);

	it("keeps the raw stderr as details so an unmatched failure is still diagnosable", () => {
		expect(classify(SSH_TRANSPORT_EXIT_CODE, "  some novel ssh error\n").details).toBe("some novel ssh error");
	});
});
