import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "../stores/ui-store";
import type { ProjectSettingsSaveState } from "./ProjectSettingsForm";
import { SettingsDialog } from "./SettingsDialog";

vi.mock("./ProjectSettingsForm", () => ({
	ProjectSettingsForm: ({
		onSaveState,
	}: {
		onSaveState?: (state: ProjectSettingsSaveState) => void;
	}) => (
		<button
			type="button"
			onClick={() =>
				onSaveState?.({
					isPending: true,
					showSaving: false,
					validationError: null,
					mutationError: null,
					saved: false,
					replacementError: null,
				})
			}
		>
			Start pending save
		</button>
	),
}));

vi.mock("./GlobalSettingsForm", () => ({
	GlobalSettingsForm: ({ section }: { section: string }) => <div data-testid="global-settings-section">{section}</div>,
}));

// The dialog reads the cloud gate to decide whether the Cloud nav page exists;
// mocked so these tests need no QueryClientProvider (same pattern as Sidebar).
vi.mock("../hooks/useCloudGate", () => ({
	useCloudGate: () => ({ cloudEnabled: false, localEnabled: true }),
}));

describe("SettingsDialog", () => {
	beforeEach(() => {
		useUiStore.setState({ settingsModal: null });
	});

	it("does not dismiss project settings while a save is pending", async () => {
		useUiStore.getState().openProjectSettings("proj-1");
		render(<SettingsDialog />);

		await userEvent.click(await screen.findByRole("button", { name: "Start pending save" }));
		const closeButton = screen.getByRole("button", { name: "Close settings" });
		expect(closeButton).toBeDisabled();

		await userEvent.keyboard("{Escape}");
		expect(useUiStore.getState().settingsModal).toEqual({ scope: "project", projectId: "proj-1" });
	});

	it("opens the requested global settings page", async () => {
		useUiStore.getState().openGlobalSettings("mobile");
		render(<SettingsDialog />);

		expect(await screen.findByTestId("global-settings-section")).toHaveTextContent("mobile");
		expect(screen.getByRole("button", { name: "Mobile" })).toHaveAttribute("aria-current", "page");
	});
});
