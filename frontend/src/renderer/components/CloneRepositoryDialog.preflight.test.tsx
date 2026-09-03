import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CloneRepositoryDialog, { type CloneRepositoryDetails } from "./CloneRepositoryDialog";

const postMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/api-client", () => ({
	apiClient: { POST: postMock },
	apiErrorMessage: (error: unknown) =>
		typeof error === "object" && error !== null && "message" in error
			? String((error as { message: unknown }).message)
			: "Could not inspect clone destination.",
}));

function Harness({ initial }: { initial: CloneRepositoryDetails }) {
	const [value, setValue] = useState(initial);
	return (
		<CloneRepositoryDialog
			disabled={false}
			error={null}
			onBack={vi.fn()}
			onChange={setValue}
			onClose={vi.fn()}
			onContinue={vi.fn()}
			open
			value={value}
		/>
	);
}

function result(destinationParent: string, targetPath = "", available = true) {
	return { data: { destinationParent, targetPath, available }, error: undefined };
}

beforeEach(() => {
	postMock.mockReset();
});

describe("CloneRepositoryDialog destination preflight", () => {
	it("loads the daemon-configured default destination when none was chosen", async () => {
		postMock.mockResolvedValue(result("/home/test/.ao/repos"));

		render(<Harness initial={{ remoteUrl: "", destinationParent: "" }} />);

		expect(await screen.findByText("/home/test/.ao/repos")).toBeInTheDocument();
		expect(postMock).toHaveBeenCalledWith(
			"/api/v1/projects/clone/preflight",
			expect.objectContaining({
				body: { remoteUrl: "", destinationParent: "" },
				signal: expect.any(AbortSignal),
			}),
		);
	});

	it("shows the exact occupied target and disables Continue", async () => {
		postMock.mockResolvedValue(result("/repos", "/repos/widget", false));

		render(<Harness initial={{ remoteUrl: "https://github.com/acme/widget.git", destinationParent: "/repos" }} />);

		expect(await screen.findByText(/\/repos\/widget/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
	});

	it("revalidates a changed URL and clears an earlier collision", async () => {
		postMock
			.mockResolvedValueOnce(result("/repos", "/repos/widget", false))
			.mockResolvedValueOnce(result("/repos", "/repos/fresh", true));
		render(<Harness initial={{ remoteUrl: "https://github.com/acme/widget.git", destinationParent: "/repos" }} />);
		expect(await screen.findByText(/\/repos\/widget/)).toBeInTheDocument();

		const input = screen.getByLabelText("Repository URL");
		fireEvent.change(input, { target: { value: "https://github.com/acme/fresh.git" } });

		await waitFor(() => expect(postMock).toHaveBeenLastCalledWith(
			"/api/v1/projects/clone/preflight",
			expect.objectContaining({
				body: { remoteUrl: "https://github.com/acme/fresh.git", destinationParent: "/repos" },
			}),
		));
		await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
	});

	it("aborts the stale observation when the destination changes", async () => {
		let firstSignal: AbortSignal | undefined;
		postMock
			.mockImplementationOnce((_path: string, options: { signal?: AbortSignal }) => {
				firstSignal = options.signal;
				return new Promise(() => undefined);
			})
			.mockResolvedValueOnce(result("/second", "/second/widget", true));
		const props = {
			disabled: false,
			error: null,
			onBack: vi.fn(),
			onChange: vi.fn(),
			onClose: vi.fn(),
			onContinue: vi.fn(),
			open: true,
		};
		const { rerender } = render(
			<CloneRepositoryDialog {...props} value={{ remoteUrl: "https://github.com/acme/widget.git", destinationParent: "/first" }} />,
		);
		await waitFor(() => expect(firstSignal).toBeDefined());

		rerender(
			<CloneRepositoryDialog {...props} value={{ remoteUrl: "https://github.com/acme/widget.git", destinationParent: "/second" }} />,
		);

		await waitFor(() => expect(firstSignal?.aborted).toBe(true));
		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
	});
});
