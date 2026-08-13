import { describe, expect, it } from "vitest";
import { terminalInterfaceFailureRecovery } from "./terminalInterfaceRecovery";

describe("terminalInterfaceFailureRecovery", () => {
	it("offers an explicit destructive interrupt retry when a preserved draft blocks drain", () => {
		const recovery = terminalInterfaceFailureRecovery({ errorCode: "DRAIN_DRAFT_PRESENT" });

		expect(recovery).toMatchObject({
			actionLabel: "Discard draft and switch",
			policy: "interrupt",
			confirmStyle: "destructive",
		});
		expect(recovery?.confirmationTitle).toMatch(/discard draft/i);
		expect(recovery?.confirmationMessage).toMatch(/unsent terminal draft/i);
		expect(recovery?.confirmationMessage).toMatch(/cannot be undone/i);
	});

	it("does not advertise draft destruction for unrelated transition failures", () => {
		expect(terminalInterfaceFailureRecovery({ errorCode: "DRAIN_QUIESCENCE_UNVERIFIED" })).toBeUndefined();
		expect(terminalInterfaceFailureRecovery({ errorCode: "TARGET_RESUME_FAILED" })).toBeUndefined();
		expect(terminalInterfaceFailureRecovery(undefined)).toBeUndefined();
	});
});
