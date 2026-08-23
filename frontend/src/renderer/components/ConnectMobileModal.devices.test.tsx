import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { TooltipProvider } from "./ui/tooltip";

const { get, mobileStatus } = vi.hoisted(() => ({
	get: vi.fn(),
	mobileStatus: {
		enabled: true,
		host: "192.168.1.20",
		tailscaleHost: "",
		port: 3011,
		password: "hunter2secret",
		warning: "",
		securePairing: {
			enabled: false,
			available: false,
			active: false,
			host: "",
			port: 0,
			reason: "",
		},
	},
}));

vi.mock("../lib/telemetry", () => ({ captureRendererEvent: vi.fn() }));
vi.mock("../lib/api-client", () => ({
	apiClient: { GET: get, POST: vi.fn() },
	apiErrorMessage: () => "failed",
}));

import { ConnectMobileModal } from "./ConnectMobileModal";

test("keeps connected-device management out of the pairing modal", async () => {
	get.mockImplementation(async (path: string) => {
		if (path === "/api/v1/mobile/status") return { data: mobileStatus, error: undefined };
		if (path === "/api/v1/mobile/devices") return { data: { devices: [] }, error: undefined };
		return { data: undefined, error: { message: "unexpected path" } };
	});
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<ConnectMobileModal open onOpenChange={vi.fn()} />
			</TooltipProvider>
		</QueryClientProvider>,
	);

	await waitFor(() => expect(get).toHaveBeenCalledWith("/api/v1/mobile/status"));
	expect(screen.queryByRole("heading", { name: "Connected devices" })).not.toBeInTheDocument();
	expect(get).not.toHaveBeenCalledWith("/api/v1/mobile/devices");
});
