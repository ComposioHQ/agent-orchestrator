import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CloneRepositoryDialog, { joinCloneDestination, repositoryNameFromGitUrl } from "./CloneRepositoryDialog";

function cloneDialogProps(
	overrides: Partial<React.ComponentProps<typeof CloneRepositoryDialog>> = {},
): React.ComponentProps<typeof CloneRepositoryDialog> {
	return {
		disabled: false,
		error: null,
		onBack: vi.fn(),
		onChange: vi.fn(),
		onClose: vi.fn(),
		onContinue: vi.fn(),
		onError: vi.fn(),
		open: true,
		value: { remoteUrl: "https://github.com/acme/web-app.git", destinationParent: "/code" },
		...overrides,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("clone repository input", () => {
	it.each([
		["https://github.com/acme/web-app.git", "web-app"],
		["https://git.example.com/web-app.git", "web-app"],
		["ssh://git@github.com/acme/web-app.git", "web-app"],
		["git@github.com:acme/web-app.git", "web-app"],
		["file:///tmp/web-app", "web-app"],
		["file:///tmp/my%20repo.git", "my repo"],
		["https://github.com/acme/nested%2Frepo.git", "repo"],
		["file:///tmp/literal%252Frepo.git", "literal%2Frepo"],
	])("derives the checkout name from %s", (remoteUrl, expected) => {
		expect(repositoryNameFromGitUrl(remoteUrl)).toBe(expected);
	});

	it.each([
		"repository-without-a-scheme",
		"--upload-pack=malicious",
		"https://user:secret@example.com/acme/repo.git",
		"https://example.com/acme/repo.git?access_token=secret",
		"ssh://git:secret@example.com/acme/repo.git",
		"https://github.com/acme/two words.git",
		"https://github.com/acme/web-app/pull/123",
		"https://github.com/acme/web-app/issues/12",
		"https://gitlab.com/acme/web-app/-/merge_requests/12",
		"file:///tmp/bad%ZZ.git",
	])("rejects unsafe or incomplete URL %s", (remoteUrl) => {
		expect(repositoryNameFromGitUrl(remoteUrl)).toBeNull();
	});

	it("joins POSIX and Windows destinations", () => {
		expect(joinCloneDestination("/Users/me/Code/", "web-app")).toBe("/Users/me/Code/web-app");
		expect(joinCloneDestination("C:\\Code\\", "web-app")).toBe("C:\\Code\\web-app");
	});

	it("keeps Continue disabled until a destination is selected", async () => {
		window.ao!.app.checkGitRepository = vi.fn().mockResolvedValue(true);
		const onContinue = vi.fn();
		const onError = vi.fn();
		render(React.createElement(CloneRepositoryDialog, cloneDialogProps({
			onContinue,
			onError,
			value: { remoteUrl: "https://github.com/acme/web-app.git", destinationParent: "" },
		})));

		await waitFor(() => expect(window.ao!.app.checkGitRepository).toHaveBeenCalledOnce());
		const continueButton = screen.getByRole("button", { name: "Continue" });
		expect(continueButton).toBeDisabled();
		fireEvent.submit(continueButton.closest("form")!);
		expect(onContinue).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalledWith("Choose a destination folder.");
	});

	it("ignores an older remote check after the URL changes", async () => {
		let resolveFirst: ((exists: boolean) => void) | undefined;
		let resolveSecond: ((exists: boolean) => void) | undefined;
		window.ao!.app.checkGitRepository = vi.fn((url: string) => new Promise<boolean>((resolve) => {
			if (url.includes("first")) resolveFirst = resolve;
			else resolveSecond = resolve;
		}));
		const onError = vi.fn();
		const firstProps = cloneDialogProps({
			onError,
			value: { remoteUrl: "https://git.example.com/first.git", destinationParent: "/code" },
		});
		const view = render(React.createElement(CloneRepositoryDialog, firstProps));

		await waitFor(() => expect(window.ao!.app.checkGitRepository).toHaveBeenCalledWith("https://git.example.com/first.git"));
		view.rerender(React.createElement(CloneRepositoryDialog, {
			...firstProps,
			value: { remoteUrl: "https://git.example.com/second.git", destinationParent: "/code" },
		}));
		await waitFor(() => expect(window.ao!.app.checkGitRepository).toHaveBeenCalledWith("https://git.example.com/second.git"));

		await act(async () => resolveSecond?.(true));
		await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
		await act(async () => resolveFirst?.(false));

		expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
		expect(onError).not.toHaveBeenCalled();
	});

	it("checks the remote again each time the dialog opens", async () => {
		window.ao!.app.checkGitRepository = vi.fn().mockResolvedValue(true);
		const props = cloneDialogProps();
		const view = render(React.createElement(CloneRepositoryDialog, props));

		await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
		view.rerender(React.createElement(CloneRepositoryDialog, { ...props, open: false }));
		view.rerender(React.createElement(CloneRepositoryDialog, { ...props, open: true }));

		expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
		await waitFor(() => expect(window.ao!.app.checkGitRepository).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
	});

	it("announces an unavailable repository and shakes the dialog", async () => {
		window.ao!.app.checkGitRepository = vi.fn().mockResolvedValue(false);
		const onError = vi.fn();
		render(React.createElement(CloneRepositoryDialog, cloneDialogProps({ onError })));

		await waitFor(() => expect(onError).toHaveBeenCalledWith("This isn't a repository or you don't have access"));
		const input = screen.getByRole("textbox", { name: "Repository URL" });
		expect(input).toHaveAttribute("aria-invalid", "true");
		expect(input).toHaveAttribute("aria-describedby", expect.stringContaining("cloneRepositoryUrlError"));
		expect(screen.getByRole("alert")).toHaveTextContent("This isn't a repository or you don't have access");
		await waitFor(() => expect(screen.getByRole("dialog", { name: "Clone a Git repository" })).toHaveClass("modal-shake"));
	});

	it("discards a destination picker result after the dialog closes", async () => {
		let resolvePicker: ((path: string) => void) | undefined;
		window.ao!.app.chooseDirectory = vi.fn(() => new Promise<string>((resolve) => {
			resolvePicker = resolve;
		}));
		const onChange = vi.fn();
		const props = cloneDialogProps({ onChange });
		const view = render(React.createElement(CloneRepositoryDialog, props));

		fireEvent.click(screen.getByRole("button", { name: "Choose" }));
		await waitFor(() => expect(window.ao!.app.chooseDirectory).toHaveBeenCalledOnce());
		view.rerender(React.createElement(CloneRepositoryDialog, { ...props, open: false }));
		await act(async () => resolvePicker?.("/stale/path"));

		expect(onChange).not.toHaveBeenCalled();
	});
});
