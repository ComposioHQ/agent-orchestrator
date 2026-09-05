import { describe, expect, it } from "vitest";
import { formatOrchestratorStartupError } from "./orchestrator-startup-error";

describe("formatOrchestratorStartupError", () => {
	it("replaces unresolved child remote errors with setup guidance", () => {
		const message =
			`Project added, but orchestrator did not start: spawn workspace3-1: workspace: gitworktree: resolve workspace repo "test" base: workspace: default branch is unresolved: could not resolve remote "origin" HEAD for repository "/tmp/workspace3/test" (git -C /tmp/workspace3/test ls-remote --symref -- origin HEAD: exit status 128: remote: Repository not found. fatal: repository 'https://github.com/neversettle17-101/test.git/' not found); configure this repository's primary remote and cached HEAD (for example, git -C "/tmp/workspace3/test" remote set-head <remote> <branch>) and retry (DEFAULT_BRANCH_UNRESOLVED)`;

		expect(formatOrchestratorStartupError(message)).toBe(
			'Project added, but orchestrator did not start. The child repository "test" still needs its remote repository set up at https://github.com/neversettle17-101/test.git. Create or fix that remote, then retry starting the orchestrator.',
		);
	});

	it("leaves unrelated spawn errors unchanged", () => {
		expect(formatOrchestratorStartupError("Project added, but orchestrator did not start: branch is already checked out"))
			.toBe("Project added, but orchestrator did not start: branch is already checked out");
	});
});
