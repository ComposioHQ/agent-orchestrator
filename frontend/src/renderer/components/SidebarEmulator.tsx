import { Home, Loader2, Play, RotateCcw, RotateCw, Smartphone, Square } from "lucide-react";
import type { MouseEvent } from "react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useIOSSimulator } from "../hooks/useIOSSimulator";
import { pointerToFrame, type FramePoint } from "../lib/device-viewport";
import { isMacPlatform } from "../lib/platform";
import { useUiStore } from "../stores/ui-store";
import { SectionDisclosure } from "./Sidebar";
import { Button } from "./ui/button";

/**
 * Always-available emulator docked in the left sidebar (Claude-style). Unlike
 * the inspector tab, this surface is global: it boots the shared Simulator and
 * streams its screen no matter which session is open. It only appears on macOS
 * once "Mobile Emulator" is switched on in Settings.
 *
 * The device frame is rendered contain-fit inside a fixed-height stage; pointer
 * events are mapped through the rendered frame's rect into device framebuffer
 * pixels (lib/device-viewport), matching the inspector panel's wire contract.
 */
export function SidebarEmulator() {
	const { t } = useTranslation();
	const mobileEmulatorEnabled = useUiStore((state) => state.mobileEmulatorEnabled);
	const [open, setOpen] = useState(true);
	const [text, setText] = useState("");
	const pointerStart = useRef<FramePoint | null>(null);
	// The stream + polls only run while the section is mounted and expanded;
	// collapsing the section or turning the toggle off stops the daemon traffic.
	const ios = useIOSSimulator(mobileEmulatorEnabled && open && isMacPlatform());
	if (!mobileEmulatorEnabled || !isMacPlatform()) return null;
	const status = ios.status.data;
	const booted = status?.state === "Booted";
	const screenshot = ios.screenshot.data;
	const frame = ios.streamFrame ?? (screenshot ? { data: screenshot.data, mimeType: screenshot.mimeType, width: screenshot.width, height: screenshot.height } : null);
	const frameWidth = frame?.width ?? status?.screenWidth ?? 0;
	const frameHeight = frame?.height ?? status?.screenHeight ?? 0;
	const permissions = ios.permissions.data;
	const toolchain = ios.toolchain.data;

	const pointerPoint = (event: MouseEvent<HTMLImageElement>): FramePoint | null => {
		const bounds = event.currentTarget.getBoundingClientRect();
		return pointerToFrame(event.clientX, event.clientY, bounds, frameWidth, frameHeight);
	};
	const startPointer = (event: MouseEvent<HTMLImageElement>) => {
		pointerStart.current = pointerPoint(event);
	};
	const sendPointer = (event: MouseEvent<HTMLImageElement>) => {
		const start = pointerStart.current;
		pointerStart.current = null;
		if (!start) return; // the gesture began outside the device frame
		const end = pointerPoint(event);
		if (!end) return; // released outside the device frame — drop the gesture
		if (Math.hypot(end.x - start.x, end.y - start.y) < 8) {
			ios.input.mutate({ action: "tap", x: end.x, y: end.y });
		} else {
			ios.input.mutate({ action: "swipe", x: start.x, y: start.y, x2: end.x, y2: end.y });
		}
	};

	return (
		<div className="flex shrink-0 flex-col gap-2 border-t border-border-strong px-2 pt-1 pb-1.5" data-testid="sidebar-emulator">
			<SectionDisclosure
				label={t("settings.mobileEmulator")}
				open={open}
				onToggle={() => setOpen((v) => !v)}
			/>
			{open ? (
				<>
					<div className="flex items-center justify-between gap-2">
						<span className="flex min-w-0 items-center gap-1 truncate text-2xs text-passive">
							<Smartphone aria-hidden="true" className="size-3 shrink-0" />
							<span className="truncate">{status?.name ?? (booted ? t("emulator.deviceLabel") : t("emulator.noDevice"))}</span>
						</span>
						<div className="flex shrink-0 gap-1">
							<Button size="sm" type="button" onClick={() => ios.start.mutate()} disabled={ios.start.isPending || booted} aria-label={t("emulator.start")} title={t("emulator.start")}>
								<Play aria-hidden="true" />
							</Button>
							<Button size="sm" type="button" variant="outline" onClick={() => ios.stop.mutate()} disabled={ios.stop.isPending || !booted} aria-label={t("emulator.stop")} title={t("emulator.stop")}>
								<Square aria-hidden="true" />
							</Button>
						</div>
					</div>
					{/* Dependencies: Xcode must be present before the simulator can boot. */}
					{toolchain && !toolchain.xcodeDetected ? (
						<div className="rounded-md border border-warning/40 bg-warning/10 p-2 text-caption text-passive">
							<p>{t("emulator.toolchainMissing")}</p>
							<p className="mt-1">{toolchain.guidanceWhyMissing ?? ""}</p>
							<div className="mt-1.5 flex gap-1.5">
								<Button size="sm" type="button" variant="outline" onClick={() => window.open(toolchain.guidanceAppStoreURL || "https://apps.apple.com/app/xcode/id497799835", "_blank")}>{t("emulator.installXcode")}</Button>
								<Button size="sm" type="button" variant="outline" onClick={() => ios.recheck.mutate()} disabled={ios.recheck.isPending}>{t("emulator.recheck")}</Button>
							</div>
						</div>
					) : null}
					{permissions && (!permissions.screenRecording || !permissions.accessibility) ? <div className="rounded-md border border-warning/40 bg-warning/10 p-2 text-caption text-passive">
						<p>{t("emulator.permissionsDescription")}</p>
						<div className="mt-1.5 flex flex-wrap gap-1.5">
							{!permissions.screenRecording ? <Button size="sm" type="button" variant="outline" onClick={() => window.open("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture", "_blank")}>{t("emulator.screenRecording")}</Button> : null}
							{!permissions.accessibility ? <Button size="sm" type="button" variant="outline" onClick={() => window.open("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility", "_blank")}>{t("emulator.accessibility")}</Button> : null}
						</div>
					</div> : null}
					{/* Device stage: a fixed-height letterboxed frame so the sidebar keeps
					    its shape regardless of device aspect ratio. Clicks in the
					    letterbox never reach the simulator (pointerToFrame returns null). */}
					<div className="relative flex h-48 min-h-0 items-center justify-center overflow-hidden rounded-md border border-border bg-background/40" data-testid="emulator-stage">
						{booted && frame ? (
							<img
								alt={t("emulator.title")}
								data-testid="emulator-frame"
								draggable={false}
								className="max-h-full max-w-full touch-none rounded-sm select-none object-contain"
								style={frameWidth > 0 && frameHeight > 0 ? { aspectRatio: `${frameWidth} / ${frameHeight}` } : undefined}
								src={`data:${frame.mimeType};base64,${frame.data}`}
								onMouseDown={startPointer}
								onMouseUp={sendPointer}
								onMouseLeave={() => { pointerStart.current = null; }}
							/>
						) : booted ? (
							<p className="flex items-center gap-1.5 text-caption text-passive">
								{ios.streamState === "connecting" || ios.streamState === "idle" ? (
									<><Loader2 className="size-3.5 animate-spin" aria-hidden="true" />{t("emulator.connecting")}</>
								) : (
									<span className="text-error">{ios.streamError ?? t("emulator.disconnected")}</span>
								)}
							</p>
						) : (
							<p className="text-caption text-passive">{ios.start.isPending ? t("emulator.booting") : (status?.error ?? t("emulator.startPrompt"))}</p>
						)}
					</div>
					{booted ? (
						<div className="flex flex-wrap items-center gap-1.5">
							<Button size="sm" type="button" variant="outline" onClick={() => ios.input.mutate({ action: "home" })} aria-label={t("emulator.home")} title={t("emulator.home")}>
								<Home aria-hidden="true" />
							</Button>
							<Button size="sm" type="button" variant="outline" onClick={() => ios.input.mutate({ action: "rotateLeft" })} aria-label={t("emulator.rotateLeft")} title={t("emulator.rotateLeft")}>
								<RotateCcw aria-hidden="true" />
							</Button>
							<Button size="sm" type="button" variant="outline" onClick={() => ios.input.mutate({ action: "rotateRight" })} aria-label={t("emulator.rotateRight")} title={t("emulator.rotateRight")}>
								<RotateCw aria-hidden="true" />
							</Button>
							<form className="flex min-w-0 flex-1 gap-1.5" onSubmit={(event) => { event.preventDefault(); if (text) { ios.input.mutate({ action: "text", text }); setText(""); } }}><input aria-label={t("emulator.textInput")} className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm" value={text} onChange={(event) => setText(event.target.value)} placeholder={t("emulator.textPlaceholder")} /><Button size="sm" type="submit" disabled={!text || ios.input.isPending}>{t("emulator.send")}</Button></form>
							<Button size="sm" type="button" variant="outline" onClick={() => ios.input.mutate({ action: "key", keyCode: 36 })} aria-label={t("emulator.enter")}>{t("emulator.enter")}</Button>
							<Button size="sm" type="button" variant="outline" onClick={() => ios.input.mutate({ action: "key", keyCode: 51 })} aria-label={t("emulator.backspace")}>⌫</Button>
						</div>
					) : null}
				</>
			) : null}
		</div>
	);
}
