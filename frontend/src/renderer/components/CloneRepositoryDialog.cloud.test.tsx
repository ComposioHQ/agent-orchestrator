import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import CloneRepositoryDialog, { type CloneRepositoryDetails, type CloneRepositorySelection } from "./CloneRepositoryDialog";

const organization = { id: "org_1", slug: "dev", displayName: "Dev", role: "owner" };

function Harness({
	cloudEnabled = true,
	cloudOrganizations = [organization],
	onCloudSignIn,
	onContinue = vi.fn(),
	error = null,
}: {
	cloudEnabled?: boolean;
	cloudOrganizations?: typeof organization[];
	onCloudSignIn?: () => Promise<{ organizations: typeof organization[] } | null>;
	onContinue?: (selection: CloneRepositorySelection) => void;
	error?: string | null;
}) {
	const [value, setValue] = useState<CloneRepositoryDetails>({
		remoteUrl: "https://github.com/acme/repo.git",
		destinationParent: "",
	});
	return (
		<CloneRepositoryDialog
			cloudEnabled={cloudEnabled}
			cloudOrganizations={cloudOrganizations}
			disabled={false}
			error={error}
			onBack={() => undefined}
			onChange={setValue}
			onClose={() => undefined}
			onCloudSignIn={onCloudSignIn}
			onContinue={onContinue}
			open
			value={value}
		/>
	);
}

describe("CloneRepositoryDialog cloud location", () => {
	it("hides Cloud when cloud features are disabled", () => {
		render(<Harness cloudEnabled={false} />);
		expect(screen.queryByRole("combobox", { name: "Where should this project run?" })).not.toBeInTheDocument();
	});

	it("offers AO Cloud to a signed-in organization and submits a placement selection", async () => {
		const user = userEvent.setup();
		const onContinue = vi.fn();
		render(<Harness onContinue={onContinue} />);

		await user.click(screen.getByRole("combobox", { name: "Where should this project run?" }));
		await user.click(await screen.findByRole("option", { name: "AO Cloud" }));
		expect(screen.getByText("Cloud project")).toBeInTheDocument();
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

	it("offers Cloud while signed out and requires sign-in when selected", async () => {
		const user = userEvent.setup();
		const onCloudSignIn = vi.fn().mockResolvedValue(null);
		render(<Harness cloudOrganizations={[]} onCloudSignIn={onCloudSignIn} />);

		await user.click(screen.getByRole("combobox", { name: "Where should this project run?" }));
		await user.click(await screen.findByRole("option", { name: "AO Cloud" }));

		expect(onCloudSignIn).toHaveBeenCalledTimes(1);
		expect(await screen.findByRole("alert")).toHaveTextContent("Sign in to AO Cloud");
	});
});
