import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import CloneRepositoryDialog, { type CloneRepositoryDetails, type CloneRepositorySelection } from "./CloneRepositoryDialog";

const organization = { id: "org_1", slug: "dev", displayName: "Dev", role: "owner" };

function Harness({ onContinue = vi.fn(), error = null }: { onContinue?: (selection: CloneRepositorySelection) => void; error?: string | null }) {
	const [value, setValue] = useState<CloneRepositoryDetails>({
		remoteUrl: "https://github.com/acme/repo.git",
		destinationParent: "",
	});
	return (
		<CloneRepositoryDialog
			cloudOrganizations={[organization]}
			disabled={false}
			error={error}
			onBack={() => undefined}
			onChange={setValue}
			onClose={() => undefined}
			onContinue={onContinue}
			open
			value={value}
		/>
	);
}

describe("CloneRepositoryDialog cloud location", () => {
	it("offers AO Cloud to a signed-in organization and submits a placement selection", async () => {
		const user = userEvent.setup();
		const onContinue = vi.fn();
		render(<Harness onContinue={onContinue} />);

		await user.click(screen.getByRole("combobox", { name: "Project location" }));
		await user.click(await screen.findByRole("option", { name: "AO Cloud" }));
		expect(screen.getByText("Create in AO Cloud")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Continue" }));

		expect(onContinue).toHaveBeenCalledWith(expect.objectContaining({
			location: "cloud",
			organizationId: "org_1",
			remoteUrl: "https://github.com/acme/repo.git",
			defaultBranch: "main",
			targetPath: "",
		}));
	});

	it("keeps cloud placement failures visible for retry", () => {
		render(<Harness error="Provisioning capacity is temporarily unavailable" />);
		expect(screen.getByRole("alert")).toHaveTextContent("Provisioning capacity is temporarily unavailable");
	});
});
