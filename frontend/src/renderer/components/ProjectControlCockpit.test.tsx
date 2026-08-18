import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getMock, putMock } = vi.hoisted(() => ({ getMock: vi.fn(), putMock: vi.fn() }));

vi.mock("../lib/api-client", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/api-client")>()),
	apiClient: { GET: getMock, PUT: putMock },
}));

import { ProjectControlCockpit } from "./ProjectControlCockpit";
import { projectControlQueryKey } from "../lib/project-control";

const unconfigured = {
	projectId: "ao",
	configured: false,
	revision: 0,
	health: "unconfigured" as const,
	confidence: "unknown" as const,
};

const configured = {
	projectId: "ao",
	configured: true,
	revision: 4,
	health: "unknown" as const,
	confidence: "unknown" as const,
	outcome: {
		id: "outcome-1",
		owner: "role:project-owner" as const,
		statement: "Ship the cockpit",
		criteria: [
			{ id: "criterion-b", statement: "Second", verificationMethod: "Review B", displayOrder: 1 },
			{ id: "criterion-a", statement: "First", verificationMethod: "Review A", displayOrder: 0 },
		],
	},
};

function renderCockpit() {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	const rendered = render(
		<QueryClientProvider client={queryClient}>
			<ProjectControlCockpit projectId="ao" />
		</QueryClientProvider>,
	);
	return { ...rendered, queryClient };
}

beforeEach(() => {
	getMock.mockReset();
	putMock.mockReset();
});

describe("ProjectControlCockpit", () => {
	it("shows the unconfigured state and opens configure", async () => {
		getMock.mockResolvedValue({ data: unconfigured });
		renderCockpit();

		expect(await screen.findByText("Define the durable outcome and how it will be accepted.")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Configure" }));
		expect(screen.getByLabelText("Outcome statement")).toHaveValue("");
		expect(screen.getByLabelText("Criterion 1 statement")).toHaveValue("");
	});

	it("shows configured state in stable display order with unknown health and confidence", async () => {
		getMock.mockResolvedValue({ data: configured });
		renderCockpit();

		expect(await screen.findByText("Ship the cockpit")).toBeInTheDocument();
		expect(screen.getByText("Revision 4")).toBeInTheDocument();
		expect(screen.getByText("Health: unknown")).toBeInTheDocument();
		expect(screen.getByText("Confidence: unknown")).toBeInTheDocument();
		const rows = screen.getAllByRole("listitem");
		expect(rows.map((row) => row.getAttribute("data-criterion-id"))).toEqual(["criterion-a", "criterion-b"]);
	});

	it("configures with revision zero, omits a new criterion id, and supplies an idempotency key", async () => {
		getMock.mockResolvedValue({ data: unconfigured });
		putMock.mockResolvedValue({ data: { ...configured, revision: 1 } });
		renderCockpit();

		await userEvent.click(await screen.findByRole("button", { name: "Configure" }));
		await userEvent.type(screen.getByLabelText("Outcome statement"), "Ship slice one");
		await userEvent.type(screen.getByLabelText("Criterion 1 statement"), "UI passes");
		await userEvent.type(screen.getByLabelText("Criterion 1 verification method"), "Frontend test");
		await userEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		const request = putMock.mock.calls[0][1];
		expect(request.body).toMatchObject({
			statement: "Ship slice one",
			expectedRevision: 0,
			criteria: [{ statement: "UI passes", verificationMethod: "Frontend test", displayOrder: 0 }],
		});
		expect(request.body.criteria[0]).not.toHaveProperty("id");
		expect(request.body.idempotencyKey).toMatch(/^desktop-/);
	});

	it("edits with existing stable IDs, omits only new IDs, and uses a fresh key for each command", async () => {
		getMock.mockResolvedValue({ data: configured });
		putMock
			.mockResolvedValueOnce({ data: { ...configured, revision: 5 } })
			.mockResolvedValueOnce({ data: { ...configured, revision: 6 } });
		renderCockpit();

		await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
		await userEvent.click(screen.getByRole("button", { name: "Add criterion" }));
		await userEvent.type(screen.getByLabelText("Criterion 3 statement"), "Third");
		await userEvent.type(screen.getByLabelText("Criterion 3 verification method"), "Review C");
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));

		const first = putMock.mock.calls[0][1].body;
		expect(first.expectedRevision).toBe(4);
		expect(first.criteria.map((criterion: { id?: string }) => criterion.id)).toEqual([
			"criterion-a",
			"criterion-b",
			undefined,
		]);

		await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(2));
		const second = putMock.mock.calls[1][1].body;
		expect(second.expectedRevision).toBe(5);
		expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
	});

	it("preserves the edit-base revision when the query updates while the form is open", async () => {
		getMock.mockResolvedValue({ data: configured });
		putMock.mockResolvedValue({ data: { ...configured, revision: 6 } });
		const { queryClient } = renderCockpit();

		await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
		await userEvent.clear(screen.getByLabelText("Outcome statement"));
		await userEvent.type(screen.getByLabelText("Outcome statement"), "Draft from revision four");

		queryClient.setQueryData(projectControlQueryKey("ao"), {
			...configured,
			revision: 5,
			outcome: { ...configured.outcome, statement: "Concurrent durable update" },
		});
		await userEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		expect(putMock.mock.calls[0][1].body).toMatchObject({
			statement: "Draft from revision four",
			expectedRevision: 4,
		});
	});

	it("keeps a typed revision conflict visible and reloads current durable state", async () => {
		getMock
			.mockResolvedValueOnce({ data: { ...configured, revision: 2 } })
			.mockResolvedValueOnce({ data: { ...configured, revision: 3, outcome: { ...configured.outcome, statement: "Current durable outcome" } } });
		putMock.mockResolvedValue({
			error: {
				error: "conflict",
				code: "PROJECT_CONTROL_REVISION_CONFLICT",
				message: "Project control revision conflict",
				details: { currentRevision: 3 },
			},
		});
		renderCockpit();

		await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
		await userEvent.clear(screen.getByLabelText("Outcome statement"));
		await userEvent.type(screen.getByLabelText("Outcome statement"), "Stale overwrite");
		await userEvent.click(screen.getByRole("button", { name: "Save" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("A newer revision (3) was saved");
		expect(screen.getByLabelText("Outcome statement")).toHaveValue("Current durable outcome");
		expect(getMock).toHaveBeenCalledTimes(2);
	});
});
