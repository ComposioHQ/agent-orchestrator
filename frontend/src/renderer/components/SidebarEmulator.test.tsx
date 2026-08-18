import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamFrame, StreamState } from "../hooks/useIOSSimulator";
import { useUiStore } from "../stores/ui-store";
import { SidebarEmulator } from "./SidebarEmulator";

// The panel only mounts on macOS; force the platform check on for every case.
// SectionDisclosure comes from Sidebar.tsx, which reads other platform flags at
// module scope, so the mock must cover the whole surface.
vi.mock("../lib/platform", () => ({
	isMacPlatform: () => true,
	isWindowsPlatform: () => false,
	isLinuxPlatform: () => false,
	usesFramedAppTopbar: () => true,
	hidesShellTopbar: () => true,
	usesBoardActionsInPanel: () => true,
}));

const { inputMutate, startMutate, stopMutate, recheckMutate, pointerToFrame, hookState } = vi.hoisted(() => ({
	inputMutate: vi.fn(),
	startMutate: vi.fn(),
	stopMutate: vi.fn(),
	recheckMutate: vi.fn(),
	pointerToFrame: vi.fn(),
	hookState: { current: undefined as unknown },
}));

vi.mock("../hooks/useIOSSimulator", () => ({
	useIOSSimulator: () => hookState.current,
}));

vi.mock("../lib/device-viewport", () => ({
	pointerToFrame: (...args: Parameters<typeof pointerToFrame>) => pointerToFrame(...args),
}));

const query = <T,>(data: T | undefined, overrides: Record<string, unknown> = {}) => ({
	data,
	isPending: false,
	isSuccess: data !== undefined,
	status: data !== undefined ? "success" : "error",
	refetch: vi.fn(),
	...overrides,
});

const mutation = (overrides: Record<string, unknown> = {}) => ({
	mutate: vi.fn(),
	isPending: false,
	...overrides,
});

type StatusData = { state: string; name: string | null; error: string | null };
type ToolchainData = {
	xcodeDetected: boolean;
	guidanceWhyMissing: string | null;
	guidanceAppStoreURL: string | null;
};
type PermissionsData = { screenRecording: boolean; accessibility: boolean };
type QueryResult<T> = ReturnType<typeof query<T>>;
type MutationResult = ReturnType<typeof mutation>;

export type EmulatorMockHook = {
	status: QueryResult<StatusData>;
	toolchain: QueryResult<ToolchainData>;
	recheck: MutationResult;
	start: MutationResult;
	stop: MutationResult;
	screenshot: QueryResult<{ data: string; mimeType: string; width: number; height: number }>;
	streamFrame: StreamFrame | null;
	streamState: StreamState;
	streamError: string | null;
	permissions: QueryResult<PermissionsData>;
	input: MutationResult;
};

function buildHook(): EmulatorMockHook {
	return {
		status: query<StatusData>({ state: "Shutdown", name: "iPhone 15", error: null }),
		toolchain: query<ToolchainData>({ xcodeDetected: true, guidanceWhyMissing: null, guidanceAppStoreURL: null }),
		recheck: mutation({ mutate: recheckMutate }),
		start: mutation({ mutate: startMutate }),
		stop: mutation({ mutate: stopMutate }),
		screenshot: query(undefined),
		streamFrame: null,
		streamState: "idle",
		streamError: null,
		permissions: query<PermissionsData>({ screenRecording: true, accessibility: true }),
		input: mutation({ mutate: inputMutate }),
	};
}

function renderPanel(overrides: Partial<EmulatorMockHook> = {}) {
	hookState.current = { ...buildHook(), ...overrides };
	useUiStore.setState({ mobileEmulatorEnabled: true });
	return render(<SidebarEmulator />);
}

beforeEach(() => {
	inputMutate.mockReset();
	startMutate.mockReset();
	stopMutate.mockReset();
	recheckMutate.mockReset();
	pointerToFrame.mockReset();
	vi.spyOn(window, "open").mockImplementation(() => null);
	hookState.current = buildHook();
	useUiStore.setState({ mobileEmulatorEnabled: true });
});

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = "";
	useUiStore.setState({ mobileEmulatorEnabled: false });
});

describe("SidebarEmulator gating", () => {
	it("renders nothing when the Mobile Emulator toggle is off", () => {
		useUiStore.setState({ mobileEmulatorEnabled: false });
		render(<SidebarEmulator />);
		expect(screen.queryByTestId("sidebar-emulator")).not.toBeInTheDocument();
	});

	it("renders the section header when enabled", () => {
		renderPanel();
		expect(screen.getByTestId("sidebar-emulator")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Mobile Emulator" })).toBeInTheDocument();
	});

	it("collapses and expands the device body", () => {
		const first = renderPanel({
			status: query({ state: "Booted", name: "iPhone 15", error: null }),
			streamFrame: { data: "aGVsbG8=", mimeType: "image/png", width: 1179, height: 2556 },
		});
		expect(screen.getByTestId("emulator-frame")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Mobile Emulator" }));
		expect(screen.queryByTestId("emulator-frame")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Mobile Emulator" }));
		expect(screen.getByTestId("emulator-frame")).toBeInTheDocument();
		first.unmount();
	});
});

describe("SidebarEmulator states", () => {
	it("shows the booted device label and device frame", () => {
		renderPanel({
			status: query({ state: "Booted", name: "iPhone 15", error: null }),
			streamFrame: { data: "aGVsbG8=", mimeType: "image/png", width: 1179, height: 2556 },
		});
		expect(screen.getByText("iPhone 15")).toBeInTheDocument();
		expect(screen.getByTestId("emulator-frame")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
	});

	it("falls back to the screenshot poll when the stream has not sent a frame", () => {
		renderPanel({
			status: query({ state: "Booted", name: "iPhone 15", error: null }),
			screenshot: query({ data: "c2NyZWVu", mimeType: "image/jpeg", width: 1179, height: 2556 }),
		});
		const frame = screen.getByTestId("emulator-frame");
		expect(frame).toHaveAttribute("src", "data:image/jpeg;base64,c2NyZWVu");
	});

	it("shows the connecting message while the stream is starting", () => {
		renderPanel({
			status: query({ state: "Booted", name: "iPhone 15", error: null }),
			streamState: "connecting",
			streamError: null,
		});
		expect(screen.getByText("Connecting to simulator…")).toBeInTheDocument();
	});

	it("surfaces the stream error when the stream stalls", () => {
		renderPanel({
			status: query({ state: "Booted", name: "iPhone 15", error: null }),
			streamState: "stalled",
			streamError: "ScreenCaptureKit stopped",
		});
		expect(screen.getByText("ScreenCaptureKit stopped")).toBeInTheDocument();
	});

	it("shows the booting message while a start is pending", () => {
		renderPanel({
			start: mutation({ mutate: startMutate, isPending: true }),
		});
		expect(screen.getByText("Booting simulator…")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
	});

	it("shows the start prompt when nothing is running and no error is known", () => {
		renderPanel({
			status: query({ state: "Shutdown", name: null, error: null }),
		});
		expect(screen.getByText("Start the simulator to see its screen.")).toBeInTheDocument();
	});
});

describe("SidebarEmulator dependencies", () => {
	it("advertises the missing Xcode toolchain with install and recheck actions", () => {
		renderPanel({
			toolchain: query({
				xcodeDetected: false,
				guidanceWhyMissing: "Install Xcode 15 or newer.",
				guidanceAppStoreURL: "https://apps.apple.com/app/xcode/id497799835",
			}),
		});
		expect(screen.getByText("Xcode is required to run the iOS Simulator.")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Install Xcode" }));
		expect(window.open).toHaveBeenCalledWith(
			"https://apps.apple.com/app/xcode/id497799835",
			"_blank",
		);
		fireEvent.click(screen.getByRole("button", { name: "Recheck" }));
		expect(recheckMutate).toHaveBeenCalled();
	});

	it("lists each missing permission with its settings deep link", () => {
		renderPanel({
			permissions: query({ screenRecording: false, accessibility: false }),
		});
		fireEvent.click(screen.getByRole("button", { name: "Screen Recording" }));
		expect(window.open).toHaveBeenCalledWith(
			"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
			"_blank",
		);
		fireEvent.click(screen.getByRole("button", { name: "Accessibility" }));
		expect(window.open).toHaveBeenCalledWith(
			"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
			"_blank",
		);
	});
});

describe("SidebarEmulator input", () => {
	const booted = {
		status: query({ state: "Booted", name: "iPhone 15", error: null }),
		streamFrame: { data: "aGVsbG8=", mimeType: "image/png", width: 1179, height: 2556 },
	};

	it("maps a pointerdown/up inside the frame to a tap", () => {
		pointerToFrame.mockReturnValue({ x: 200, y: 400 });
		renderPanel(booted);
		const frame = screen.getByTestId("emulator-frame");
		fireEvent.mouseDown(frame, { clientX: 100, clientY: 150 });
		fireEvent.mouseUp(frame, { clientX: 103, clientY: 152 });
		expect(inputMutate).toHaveBeenCalledWith({ action: "tap", x: 200, y: 400 });
	});

	it("maps a longer pointerdown/up drag to a swipe with start and end points", () => {
		pointerToFrame
			.mockReturnValueOnce({ x: 30, y: 300 })
			.mockReturnValueOnce({ x: 600, y: 300 });
		renderPanel(booted);
		const frame = screen.getByTestId("emulator-frame");
		fireEvent.mouseDown(frame, { clientX: 10, clientY: 100 });
		fireEvent.mouseUp(frame, { clientX: 200, clientY: 100 });
		expect(inputMutate).toHaveBeenCalledWith({ action: "swipe", x: 30, y: 300, x2: 600, y2: 300 });
	});

	it("ignores pointer interactions that start or end outside the frame", () => {
		pointerToFrame
			.mockReturnValueOnce(null)
			.mockReturnValueOnce({ x: 10, y: 10 });
		renderPanel(booted);
		const frame = screen.getByTestId("emulator-frame");
		fireEvent.mouseDown(frame, { clientX: 5, clientY: 5 });
		fireEvent.mouseUp(frame, { clientX: 50, clientY: 50 });
		expect(inputMutate).not.toHaveBeenCalled();
	});

	it("dispatches home and orientation shortcuts", () => {
		renderPanel(booted);
		fireEvent.click(screen.getByRole("button", { name: "Home" }));
		expect(inputMutate).toHaveBeenCalledWith({ action: "home" });
		fireEvent.click(screen.getByRole("button", { name: "Rotate Left" }));
		expect(inputMutate).toHaveBeenCalledWith({ action: "rotateLeft" });
		fireEvent.click(screen.getByRole("button", { name: "Rotate Right" }));
		expect(inputMutate).toHaveBeenCalledWith({ action: "rotateRight" });
	});

	it("sends typed text and clears the field", () => {
		renderPanel(booted);
		const field = screen.getByRole("textbox", { name: "Simulator text input" });
		fireEvent.change(field, { target: { value: "app store" } });
		fireEvent.submit(field.closest("form") as HTMLFormElement);
		expect(inputMutate).toHaveBeenCalledWith({ action: "text", text: "app store" });
		expect(field).toHaveValue("");
	});

	it("dispatches enter and backspace keys", () => {
		renderPanel(booted);
		fireEvent.click(screen.getByRole("button", { name: "Enter" }));
		expect(inputMutate).toHaveBeenCalledWith({ action: "key", keyCode: 36 });
		fireEvent.click(screen.getByRole("button", { name: "Backspace" }));
		expect(inputMutate).toHaveBeenCalledWith({ action: "key", keyCode: 51 });
	});

	it("starts and stops the simulator from the header buttons", () => {
		const first = renderPanel();
		fireEvent.click(screen.getByRole("button", { name: "Start" }));
		expect(startMutate).toHaveBeenCalled();
		first.unmount();
		renderPanel(booted);
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(stopMutate).toHaveBeenCalled();
	});
});