import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmulatorPanel } from "./EmulatorPanel";
import type { AndroidEmulatorStatus, AndroidSDKStatus } from "../hooks/useAndroidDevice";

const hookState = vi.hoisted(() => ({
	sdk: { data: undefined as AndroidSDKStatus | undefined, isLoading: false },
	emulator: { data: undefined as AndroidEmulatorStatus | undefined },
	setupMutate: vi.fn(),
	startMutate: vi.fn(),
	stopMutate: vi.fn(),
	useExistingMutate: vi.fn(),
	setupError: undefined as unknown,
	useExistingError: undefined as unknown,
	sendInputMutate: vi.fn(),
	frameUrl: null as string | null,
}));

vi.mock("../hooks/useAndroidDevice", () => ({
	useAndroidDevice: () => ({
		sdk: hookState.sdk,
		emulator: hookState.emulator,
		setup: { mutate: hookState.setupMutate, isPending: false, error: hookState.setupError },
		start: { mutate: hookState.startMutate, isPending: false },
		stop: { mutate: hookState.stopMutate, isPending: false },
		useExisting: { mutate: hookState.useExistingMutate, isPending: false, error: hookState.useExistingError },
	}),
	useSendAndroidInput: () => ({ mutate: hookState.sendInputMutate }),
}));

vi.mock("../hooks/useAndroidFrameStream", () => ({
	useAndroidFrameStream: () => ({ frameUrl: hookState.frameUrl, connected: hookState.frameUrl !== null }),
}));

function noop() {}

describe("EmulatorPanel", () => {
	beforeEach(() => {
		hookState.sdk = { data: undefined, isLoading: false };
		hookState.emulator = { data: undefined };
		hookState.setupError = undefined;
		hookState.useExistingError = undefined;
		hookState.frameUrl = null;
		hookState.setupMutate.mockReset();
		hookState.startMutate.mockReset();
		hookState.stopMutate.mockReset();
		hookState.useExistingMutate.mockReset();
		hookState.sendInputMutate.mockReset();
	});

	it("shows the setup call-to-action when the SDK is not installed", () => {
		hookState.sdk = { data: { state: "not_installed" }, isLoading: false };
		render(<EmulatorPanel active poppedOut={false} onTogglePopOut={noop} />);

		expect(screen.getByText("Set up the Android emulator")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Install Android SDK (~2GB)" })).toBeInTheDocument();
	});

	it("calls setup.mutate when the install button is clicked", async () => {
		hookState.sdk = { data: { state: "not_installed" }, isLoading: false };
		render(<EmulatorPanel active poppedOut={false} onTogglePopOut={noop} />);

		await userEvent.click(screen.getByRole("button", { name: "Install Android SDK (~2GB)" }));

		expect(hookState.setupMutate).toHaveBeenCalledTimes(1);
	});

	it("shows both use-existing and download CTAs when an existing SDK is detected", () => {
		hookState.sdk = {
			data: { state: "not_installed", detected: { root: "/opt/android-sdk", apiLevel: 34, tag: "google_apis", abi: "x86_64" } },
			isLoading: false,
		};
		render(<EmulatorPanel active poppedOut={false} onTogglePopOut={noop} />);

		expect(screen.getByRole("button", { name: "Use existing SDK" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Download AO's own copy (~2GB) instead" })).toBeInTheDocument();
	});

	it("calls useExisting.mutate when the use-existing button is clicked", async () => {
		hookState.sdk = {
			data: { state: "not_installed", detected: { root: "/opt/android-sdk", apiLevel: 34, tag: "google_apis", abi: "x86_64" } },
			isLoading: false,
		};
		render(<EmulatorPanel active poppedOut={false} onTogglePopOut={noop} />);

		await userEvent.click(screen.getByRole("button", { name: "Use existing SDK" }));

		expect(hookState.useExistingMutate).toHaveBeenCalledTimes(1);
	});

	it("shows only the download CTA when no existing SDK is detected", () => {
		hookState.sdk = { data: { state: "not_installed" }, isLoading: false };
		render(<EmulatorPanel active poppedOut={false} onTogglePopOut={noop} />);

		expect(screen.queryByRole("button", { name: "Use existing SDK" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Install Android SDK (~2GB)" })).toBeInTheDocument();
	});

	it("shows download progress while the SDK is downloading", () => {
		hookState.sdk = {
			data: {
				state: "downloading",
				components: [{ component: "platform-tools", bytesDone: 50, bytesTotal: 100 }],
			},
			isLoading: false,
		};
		render(<EmulatorPanel active poppedOut={false} onTogglePopOut={noop} />);

		expect(screen.getByText("Downloading Android SDK…")).toBeInTheDocument();
		expect(screen.getByText("50% complete")).toBeInTheDocument();
	});

	it("shows a Start button once the SDK is installed but the device is not running", async () => {
		hookState.sdk = { data: { state: "installed" }, isLoading: false };
		hookState.emulator = { data: { state: "uninitialized", accelAvailable: true } };
		render(<EmulatorPanel active poppedOut={false} onTogglePopOut={noop} />);

		await userEvent.click(screen.getByRole("button", { name: "Start" }));

		expect(hookState.startMutate).toHaveBeenCalledTimes(1);
	});

	it("shows the live frame and hardware buttons once the device is running", () => {
		hookState.sdk = { data: { state: "installed" }, isLoading: false };
		hookState.emulator = { data: { state: "running", accelAvailable: true } };
		hookState.frameUrl = "blob:fake-frame";
		render(<EmulatorPanel active poppedOut={false} onTogglePopOut={noop} />);

		expect(screen.getByTestId("emulator-frame")).toHaveAttribute("src", "blob:fake-frame");
		expect(screen.getByRole("button", { name: "Home" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Recent apps" })).toBeInTheDocument();
	});

	it("sends the emulator's GoHome key action when the Home button is clicked", async () => {
		hookState.sdk = { data: { state: "installed" }, isLoading: false };
		hookState.emulator = { data: { state: "running", accelAvailable: true } };
		hookState.frameUrl = "blob:fake-frame";
		render(<EmulatorPanel active poppedOut={false} onTogglePopOut={noop} />);

		await userEvent.click(screen.getByRole("button", { name: "Home" }));

		expect(hookState.sendInputMutate).toHaveBeenCalledWith({ type: "key", key: "GoHome" });
	});

	it("sends the emulator's GoBack key action when the Back button is clicked", async () => {
		hookState.sdk = { data: { state: "installed" }, isLoading: false };
		hookState.emulator = { data: { state: "running", accelAvailable: true } };
		hookState.frameUrl = "blob:fake-frame";
		render(<EmulatorPanel active poppedOut={false} onTogglePopOut={noop} />);

		await userEvent.click(screen.getByRole("button", { name: "Back" }));

		expect(hookState.sendInputMutate).toHaveBeenCalledWith({ type: "key", key: "GoBack" });
	});

	it("shows a warning banner when hardware acceleration is unavailable", () => {
		hookState.sdk = { data: { state: "installed" }, isLoading: false };
		hookState.emulator = { data: { state: "running", accelAvailable: false, accelDetail: "no WHPX" } };
		hookState.frameUrl = "blob:fake-frame";
		render(<EmulatorPanel active poppedOut={false} onTogglePopOut={noop} />);

		expect(screen.getByTestId("emulator-accel-warning")).toHaveTextContent("no WHPX");
	});

	it("calls onTogglePopOut when the pop-out button is clicked", async () => {
		const onTogglePopOut = vi.fn();
		hookState.sdk = { data: { state: "not_installed" }, isLoading: false };
		render(<EmulatorPanel active poppedOut={false} onTogglePopOut={onTogglePopOut} />);

		await userEvent.click(screen.getByRole("button", { name: "Pop out" }));

		expect(onTogglePopOut).toHaveBeenCalledWith(true);
	});
});
