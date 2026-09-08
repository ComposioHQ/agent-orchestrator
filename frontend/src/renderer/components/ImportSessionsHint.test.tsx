import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImportSessionsHint } from "./ImportSessionsHint";
import { useImportRunStore } from "../stores/import-run-store";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("./ImportSessionDialog", () => ({
	ImportSessionDialog: ({
		projectId,
		onOpenChange,
	}: {
		projectId: string;
		onOpenChange: (open: boolean) => void;
	}) => (
		<div role="dialog">
			{projectId}
			<button onClick={() => onOpenChange(false)}>Close</button>
		</div>
	),
}));
vi.mock("../hooks/useAgentReadinessQuery", () => ({
	useHasReadyAgent: () => false,
}));
beforeEach(() => {
	useImportRunStore.setState({ runs: {} });
	window.localStorage.clear();
});

describe("project import action", () => {
	it("appears without an agent or a scan, even after the old hint was dismissed", () => {
		window.localStorage.setItem("ao.importSessionsHint.dismissed", "1");
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		render(
			<ImportSessionsHint projectId="new-project" projectName="New project" />,
		);
		expect(
			screen.getByRole("button", { name: "importSession.hintTitle" }),
		).toBeInTheDocument();
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});
	it("opens the selected project's dialog on the first click and remains available after closing", () => {
		render(
			<>
				<ImportSessionsHint projectId="a" projectName="A" />
				<ImportSessionsHint projectId="b" projectName="B" />
			</>,
		);
		fireEvent.click(screen.getByTestId("import-sessions-b"));
		expect(screen.getByRole("dialog")).toHaveTextContent("b");
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(screen.getByTestId("import-sessions-b")).toBeInTheDocument();
		fireEvent.click(screen.getByTestId("import-sessions-a"));
		expect(screen.getByRole("dialog")).toHaveTextContent("a");
	});
	it("keeps another project's progress out of this row", () => {
		useImportRunStore.setState({
			runs: {
				a: {
					projectId: "a",
					running: true,
					stopped: false,
					progress: { done: 1, total: 3, imported: 1, failed: 0 },
					errors: [],
				},
			},
		});
		render(
			<>
				<ImportSessionsHint projectId="a" projectName="A" />
				<ImportSessionsHint projectId="b" projectName="B" />
			</>,
		);
		expect(screen.getByTestId("import-sessions-a")).toHaveTextContent(
			"importSession.importingProgress",
		);
		expect(screen.getByTestId("import-sessions-b")).toHaveTextContent(
			"importSession.hintTitle",
		);
	});
});
