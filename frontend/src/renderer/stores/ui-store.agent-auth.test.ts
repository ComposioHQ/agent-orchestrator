import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "./ui-store";

describe("agent authentication flow state", () => {
	beforeEach(() => {
		useUiStore.setState({ agentAuthGeneration: 0, agentAuthTerminalRequest: null, agentAuthCheckRequest: null });
	});

	it("retains the pending terminal after an unauthorized check", () => {
		useUiStore.getState().requestAgentAuthTerminal("codex", "shellterm-one");
		useUiStore.getState().openGlobalSettings();
		const check = useUiStore.getState().agentAuthCheckRequest!;

		useUiStore.getState().completeAgentAuthCheck(check, false);

		expect(useUiStore.getState().agentAuthCheckRequest).toBeNull();
		expect(useUiStore.getState().agentAuthTerminalRequest).toMatchObject({
			agentId: "codex",
			handleId: "shellterm-one",
		});
	});

	it("does not let an older probe clear a newer authentication flow", () => {
		useUiStore.getState().requestAgentAuthTerminal("codex", "shellterm-one");
		useUiStore.getState().openGlobalSettings();
		const oldCheck = useUiStore.getState().agentAuthCheckRequest!;
		useUiStore.getState().requestAgentAuthTerminal("muse", "shellterm-two");
		useUiStore.getState().openGlobalSettings();
		const newCheck = useUiStore.getState().agentAuthCheckRequest!;

		useUiStore.getState().completeAgentAuthCheck(oldCheck, true);

		expect(useUiStore.getState().agentAuthTerminalRequest).toMatchObject({
			agentId: "muse",
			handleId: "shellterm-two",
		});
		expect(useUiStore.getState().agentAuthCheckRequest).toEqual(newCheck);
	});

	it("keeps terminal generations monotonic after an authorized flow clears", () => {
		useUiStore.getState().requestAgentAuthTerminal("codex", "shellterm-one");
		useUiStore.getState().openGlobalSettings();
		const firstCheck = useUiStore.getState().agentAuthCheckRequest!;
		useUiStore.getState().completeAgentAuthCheck(firstCheck, true);

		useUiStore.getState().requestAgentAuthTerminal("muse", "shellterm-two");

		expect(useUiStore.getState().agentAuthTerminalRequest?.nonce).toBeGreaterThan(firstCheck.generation);
	});
});
