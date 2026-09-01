import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SessionFileTabs } from "./SessionFileTabs";

describe("SessionFileTabs", () => {
	it("activates and closes language-aware file tabs", async () => {
		const onActivateFile = vi.fn();
		const onAddFeedback = vi.fn();
		const onCloseFile = vi.fn();
		render(
			<div role="tablist">
				<SessionFileTabs
					state={{ openPaths: ["src/App.tsx"], activePath: "src/App.tsx" }}
					onAddFeedback={onAddFeedback}
					onActivateFile={onActivateFile}
					onCloseFile={onCloseFile}
					onCloseAll={vi.fn()}
				/>
			</div>,
		);
		const tab = screen.getByRole("tab", { name: "App.tsx" });
		const languageIcon = tab.querySelector('[aria-hidden="true"]');
		expect(languageIcon).toBeInTheDocument();
		const closeButton = screen.getByRole("button", { name: "Close App.tsx" });
		const feedbackButton = screen.getByRole("button", { name: "Add feedback for file src/App.tsx" });
		expect(closeButton.parentElement).toHaveClass("left-2");
		expect(feedbackButton.parentElement).toHaveClass("right-1");
		expect(tab.closest("[data-terminal-tab-frame]")).not.toHaveClass("pl-3", "pr-1.5");
		await userEvent.click(languageIcon!);
		expect(onActivateFile).toHaveBeenCalledWith("src/App.tsx");
		await userEvent.click(feedbackButton);
		expect(onAddFeedback).toHaveBeenCalledWith("src/App.tsx");
		await userEvent.click(closeButton);
		expect(onCloseFile).toHaveBeenCalledWith("src/App.tsx");
	});

	it("offers close all for open files", async () => {
		const onCloseAll = vi.fn();
		render(
			<div role="tablist">
				<SessionFileTabs
					state={{ openPaths: ["README.md"], activePath: null }}
					onAddFeedback={vi.fn()}
					onActivateFile={vi.fn()}
					onCloseFile={vi.fn()}
					onCloseAll={onCloseAll}
				/>
			</div>,
		);
		await userEvent.click(screen.getByRole("button", { name: "File tab actions" }));
		await userEvent.click(await screen.findByRole("menuitem", { name: "Close all files" }));
		expect(onCloseAll).toHaveBeenCalledOnce();
	});
});
