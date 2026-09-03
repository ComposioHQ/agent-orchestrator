import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ImportValidationResult } from "../lib/import-onboarding";
import { ImportGitPreparationDialog } from "./ImportGitPreparationDialog";

function gitPrepValidation(): ImportValidationResult {
	return {
		importKind: "project",
		isValid: true,
		blockingErrors: [],
		nextStep: "prepare_git",
		root: {
			repoPath: "/repo/new-project",
			isRepo: false,
			hasCommit: false,
			hasOrigin: false,
			isEmptyFolder: false,
			needsGitInit: true,
			requiredActions: ["git_init", "git_commit", "set_remote"],
			blockingErrors: [],
		},
	};
}

function renderDialog() {
	const onBack = vi.fn();
	const onComplete = vi.fn();
	const onOpenChange = vi.fn();
	render(
		<ImportGitPreparationDialog
			disabled={false}
			open
			path="/repo/new-project"
			validation={gitPrepValidation()}
			onBack={onBack}
			onComplete={onComplete}
			onOpenChange={onOpenChange}
		/>,
	);
	return { onBack, onComplete, onOpenChange };
}

describe("ImportGitPreparationDialog", () => {
	it("disables Continue until a repository URL is entered when set_remote is required", async () => {
		renderDialog();
		const user = userEvent.setup();
		const continueButton = screen.getByRole("button", { name: "Continue" });

		expect(continueButton).toBeDisabled();

		await user.type(screen.getByLabelText("Repository URL"), "https://github.com/org/repo.git");

		expect(continueButton).toBeEnabled();
	});
});
