import {
	useRef,
	useState,
	type FormEvent,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
	type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import {
	AppWindow,
	ChevronLeft,
	CircleAlert,
	Download,
	Home,
	Loader2,
	Maximize2,
	Minimize2,
	RefreshCw,
	Send,
} from "lucide-react";
import {
	useAndroidDevice,
	useSendAndroidInput,
	type AndroidInputAction,
	type AndroidSDKStatus,
} from "../hooks/useAndroidDevice";
import { useAndroidFrameStream } from "../hooks/useAndroidFrameStream";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn } from "../lib/utils";

type EmulatorPanelProps = {
	active: boolean;
	poppedOut: boolean;
	onTogglePopOut: (next: boolean) => void;
};

// Below this many CSS pixels of pointer travel between down and up, a
// gesture is a tap; at or above it, a swipe. Matches common touch-slop
// conventions (Android's own ViewConfiguration.getScaledTouchSlop default is
// in this range).
const swipeThresholdPx = 8;

export function EmulatorPanel({ active, poppedOut, onTogglePopOut }: EmulatorPanelProps) {
	const { t } = useTranslation();
	const { sdk, emulator, setup, start, stop } = useAndroidDevice(active);
	const sendInput = useSendAndroidInput();
	const emulatorState = emulator.data?.state;
	const streamEnabled = active && emulatorState === "running";
	const { frameUrl } = useAndroidFrameStream(streamEnabled);
	const imgRef = useRef<HTMLImageElement>(null);
	const pointerDownRef = useRef<{ x: number; y: number } | null>(null);
	const [textInput, setTextInput] = useState("");

	const toDevicePoint = (event: ReactPointerEvent<HTMLImageElement>): { x: number; y: number } | null => {
		const img = imgRef.current;
		if (!img || !img.naturalWidth || !img.naturalHeight) return null;
		const rect = img.getBoundingClientRect();
		const scaleX = img.naturalWidth / rect.width;
		const scaleY = img.naturalHeight / rect.height;
		return {
			x: Math.round((event.clientX - rect.left) * scaleX),
			y: Math.round((event.clientY - rect.top) * scaleY),
		};
	};

	const handlePointerDown = (event: ReactPointerEvent<HTMLImageElement>) => {
		const point = toDevicePoint(event);
		if (!point) return;
		pointerDownRef.current = point;
	};

	const handlePointerUp = (event: ReactPointerEvent<HTMLImageElement>) => {
		const down = pointerDownRef.current;
		pointerDownRef.current = null;
		const up = toDevicePoint(event);
		if (!down || !up) return;
		const dx = Math.abs(up.x - down.x);
		const dy = Math.abs(up.y - down.y);
		const action: AndroidInputAction =
			dx < swipeThresholdPx && dy < swipeThresholdPx
				? { type: "tap", x: down.x, y: down.y }
				: { type: "swipe", x: down.x, y: down.y, x2: up.x, y2: up.y };
		sendInput.mutate(action);
	};

	const sendKey = (key: string) => sendInput.mutate({ type: "key", key });

	const submitText = (event: FormEvent) => {
		event.preventDefault();
		const text = textInput.trim();
		if (!text) return;
		sendInput.mutate({ type: "text", text });
		setTextInput("");
	};

	return (
		<div
			className={cn(
				"emulator-panel flex h-full min-h-browser-min flex-col overflow-hidden rounded-lg border border-border bg-background",
				poppedOut && "emulator-panel--popped-out",
			)}
			data-testid="emulator-panel"
			role="tabpanel"
		>
			<div
				className="emulator-panel__toolbar flex shrink-0 min-w-0 items-center gap-1 border-b border-border bg-surface p-1.5"
				data-testid="emulator-toolbar"
			>
				{emulatorState === "running" ? (
					<>
						<Button aria-label={t("emulator.home")} onClick={() => sendKey("Home")} size="icon-sm" type="button" variant="ghost">
							<Home aria-hidden="true" className="size-icon-base" />
						</Button>
						<Button aria-label={t("emulator.back")} onClick={() => sendKey("Back")} size="icon-sm" type="button" variant="ghost">
							<ChevronLeft aria-hidden="true" className="size-icon-base" />
						</Button>
						<Button
							aria-label={t("emulator.recentApps")}
							onClick={() => sendKey("AppSwitch")}
							size="icon-sm"
							type="button"
							variant="ghost"
						>
							<AppWindow aria-hidden="true" className="size-icon-base" />
						</Button>
						<form className="flex min-w-0 flex-1 items-center gap-1" onSubmit={submitText}>
							<Input
								aria-label={t("emulator.typeText")}
								className="h-browser-url font-mono text-xs"
								onChange={(event) => setTextInput(event.target.value)}
								placeholder={t("emulator.typeTextPlaceholder")}
								value={textInput}
							/>
							<Button aria-label={t("emulator.sendText")} disabled={!textInput.trim()} size="icon-sm" type="submit" variant="ghost">
								<Send aria-hidden="true" className="size-icon-base" />
							</Button>
						</form>
						<Button disabled={stop.isPending} onClick={() => stop.mutate()} size="sm" type="button" variant="outline">
							{t("emulator.stop")}
						</Button>
					</>
				) : (
					<span className="text-sm-md font-semibold text-passive">{t("emulator.title")}</span>
				)}
				<Button
					aria-label={poppedOut ? t("emulator.returnToPanel") : t("emulator.popOut")}
					className="ml-auto"
					onClick={() => onTogglePopOut(!poppedOut)}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					{poppedOut ? <Minimize2 aria-hidden="true" className="size-icon-base" /> : <Maximize2 aria-hidden="true" className="size-icon-base" />}
				</Button>
			</div>
			<div className="emulator-panel__viewport relative min-h-0 flex-1 overflow-hidden bg-background" data-testid="emulator-viewport">
				<EmulatorBody
					emulatorState={emulatorState}
					emulatorError={emulator.data?.error}
					accelAvailable={emulator.data?.accelAvailable}
					accelDetail={emulator.data?.accelDetail}
					frameUrl={frameUrl}
					imgRef={imgRef}
					onPointerDown={handlePointerDown}
					onPointerUp={handlePointerUp}
					onStart={() => start.mutate()}
					onSetup={() => setup.mutate()}
					sdk={sdk.data}
					sdkLoading={sdk.isLoading}
					setupError={setup.error}
					starting={start.isPending}
				/>
			</div>
		</div>
	);
}

function EmulatorBody({
	accelAvailable,
	accelDetail,
	emulatorError,
	emulatorState,
	frameUrl,
	imgRef,
	onPointerDown,
	onPointerUp,
	onSetup,
	onStart,
	sdk,
	sdkLoading,
	setupError,
	starting,
}: {
	accelAvailable?: boolean;
	accelDetail?: string;
	emulatorError?: string;
	emulatorState: "uninitialized" | "booting" | "running" | "crashed" | "stopping" | undefined;
	frameUrl: string | null;
	imgRef: RefObject<HTMLImageElement | null>;
	onPointerDown: (event: ReactPointerEvent<HTMLImageElement>) => void;
	onPointerUp: (event: ReactPointerEvent<HTMLImageElement>) => void;
	onSetup: () => void;
	onStart: () => void;
	sdk: AndroidSDKStatus | undefined;
	sdkLoading: boolean;
	setupError: unknown;
	starting: boolean;
}) {
	const { t } = useTranslation();

	if (sdkLoading) return <EmptyState icon={<Loader2 className="size-8 animate-spin" />} title={t("emulator.checkingSdk")} />;

	if (!sdk || sdk.state === "not_installed" || sdk.state === "failed") {
		return (
			<EmptyState
				icon={<Download className="size-8" />}
				title={t("emulator.setupTitle")}
				body={t("emulator.setupBody")}
				error={sdk?.state === "failed" ? (sdk.error ?? t("emulator.setupFailed")) : setupError ? t("emulator.setupFailed") : undefined}
				action={<Button onClick={onSetup} size="sm" type="button">{t("emulator.setupAction")}</Button>}
			/>
		);
	}

	if (sdk.state === "downloading") {
		const totalDone = sdk.components?.reduce((sum, c) => sum + c.bytesDone, 0) ?? 0;
		const totalSize = sdk.components?.reduce((sum, c) => sum + c.bytesTotal, 0) ?? 0;
		const percent = totalSize > 0 ? Math.round((totalDone / totalSize) * 100) : 0;
		return (
			<EmptyState icon={<Download className="size-8" />} title={t("emulator.downloading")}>
				<div className="w-48 overflow-hidden rounded-full bg-muted">
					<div className="h-1.5 rounded-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
				</div>
				<p className="text-xs text-muted-foreground">{t("emulator.downloadingPercent", { percent })}</p>
			</EmptyState>
		);
	}

	// sdk.state === "installed" from here on.
	if (!emulatorState || emulatorState === "uninitialized" || emulatorState === "crashed") {
		return (
			<EmptyState
				icon={emulatorState === "crashed" ? <CircleAlert className="size-8 text-destructive" /> : <RefreshCw className="size-8" />}
				title={emulatorState === "crashed" ? t("emulator.crashed") : t("emulator.readyTitle")}
				error={emulatorError}
				action={<Button disabled={starting} onClick={onStart} size="sm" type="button">{t("emulator.start")}</Button>}
			/>
		);
	}

	if (emulatorState === "booting" || emulatorState === "stopping") {
		return (
			<EmptyState
				icon={<Loader2 className="size-8 animate-spin" />}
				title={emulatorState === "booting" ? t("emulator.booting") : t("emulator.stoppingState")}
			/>
		);
	}

	// running
	return (
		<>
			{accelAvailable === false ? (
				<div
					className="absolute inset-x-2.5 top-2.5 z-10 rounded-md border border-error/35 bg-error/8 px-2.5 py-2 text-xs text-destructive"
					data-testid="emulator-accel-warning"
				>
					{t("emulator.accelUnavailable", { detail: accelDetail ?? "" })}
				</div>
			) : null}
			{frameUrl ? (
				<img
					alt={t("emulator.screenAlt")}
					className="mx-auto h-full max-w-full touch-none object-contain select-none"
					data-testid="emulator-frame"
					draggable={false}
					onPointerDown={onPointerDown}
					onPointerUp={onPointerUp}
					ref={imgRef}
					src={frameUrl}
				/>
			) : (
				<EmptyState icon={<Loader2 className="size-8 animate-spin" />} title={t("emulator.connectingStream")} />
			)}
		</>
	);
}

function EmptyState({
	action,
	body,
	children,
	error,
	icon,
	title,
}: {
	action?: ReactNode;
	body?: string;
	children?: ReactNode;
	error?: string;
	icon: ReactNode;
	title: string;
}) {
	return (
		<div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-5 text-center text-passive">
			<div className="text-passive">{icon}</div>
			<p className="text-md-sm font-medium text-muted-foreground">{title}</p>
			{body ? <p className="max-w-72 text-xs text-passive">{body}</p> : null}
			{children}
			{error ? (
				<p className="max-w-72 text-xs text-destructive" role="alert">
					{error}
				</p>
			) : null}
			{action}
		</div>
	);
}
