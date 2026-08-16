import { Play, Square } from "lucide-react";
import type { MouseEvent } from "react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useIOSSimulator } from "../hooks/useIOSSimulator";
import { isMacPlatform } from "../lib/platform";
import { Button } from "./ui/button";

export function EmulatorPanel({ active }: { active: boolean }) {
	const { t } = useTranslation();
	const ios = useIOSSimulator(active && isMacPlatform());
	if (!active || !isMacPlatform()) return null;
	const status = ios.status.data;
	const image = ios.screenshot.data;
	const streamImage = ios.streamFrame ?? image;
	const permissions = ios.permissions.data;
	const [text, setText] = useState("");
	const pointerStart = useRef<{ x: number; y: number } | null>(null);
	const sendTap = (event: MouseEvent<HTMLImageElement>) => {
		const bounds = event.currentTarget.getBoundingClientRect();
		ios.input.mutate({ action: "tap", x: event.clientX - bounds.left, y: event.clientY - bounds.top });
	};
	const sendPointer = (event: MouseEvent<HTMLImageElement>) => {
		const start = pointerStart.current;
		pointerStart.current = null;
		if (!start) return sendTap(event);
		const bounds = event.currentTarget.getBoundingClientRect();
		const end = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
		if (Math.hypot(end.x - start.x, end.y - start.y) < 8) return ios.input.mutate({ action: "tap", x: end.x, y: end.y });
		ios.input.mutate({ action: "swipe", x: start.x, y: start.y, x2: end.x, y2: end.y });
	};
	return (
		<div className="flex flex-col gap-3 p-3" role="tabpanel" aria-label={t("emulator.title")}>
			<div className="flex items-center justify-between gap-2">
				<strong className="text-sm-md">{t("emulator.title")}</strong>
				<div className="flex gap-2">
					<Button size="sm" type="button" onClick={() => ios.start.mutate()} disabled={ios.start.isPending || status?.state === "Booted"}>
						<Play className="mr-1 size-icon-2xs" />{t("emulator.start")}
					</Button>
					<Button size="sm" type="button" variant="outline" onClick={() => ios.stop.mutate()} disabled={ios.stop.isPending || status?.state !== "Booted"}>
						<Square className="mr-1 size-icon-2xs" />{t("emulator.stop")}
					</Button>
				</div>
			</div>
			{permissions && (!permissions.screenRecording || !permissions.accessibility) ? <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-caption text-passive">
				<p>{t("emulator.permissionsDescription")}</p>
				<div className="mt-2 flex gap-2">
					{!permissions.screenRecording ? <Button size="sm" type="button" variant="outline" onClick={() => window.open("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture", "_blank")}>{t("emulator.screenRecording")}</Button> : null}
					{!permissions.accessibility ? <Button size="sm" type="button" variant="outline" onClick={() => window.open("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility", "_blank")}>{t("emulator.accessibility")}</Button> : null}
				</div>
			</div> : null}
			{status?.state === "Booted" ? <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); if (text) { ios.input.mutate({ action: "text", text }); setText(""); } }}><input aria-label={t("emulator.textInput")} className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm" value={text} onChange={(event) => setText(event.target.value)} placeholder={t("emulator.textPlaceholder")} /><Button size="sm" type="submit" disabled={!text || ios.input.isPending}>{t("emulator.send")}</Button></form> : null}
			{status?.state === "Booted" ? <div className="flex gap-2"><Button size="sm" type="button" variant="outline" onClick={() => ios.input.mutate({ action: "key", keyCode: 36 })}>{t("emulator.enter")}</Button><Button size="sm" type="button" variant="outline" onClick={() => ios.input.mutate({ action: "key", keyCode: 51 })}>⌫</Button></div> : null}
			{status?.state === "Booted" && streamImage ? <img alt={t("emulator.title")} className="w-full touch-none rounded border border-border" onMouseDown={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); pointerStart.current = { x: event.clientX - bounds.left, y: event.clientY - bounds.top }; }} onMouseUp={sendPointer} src={`data:${streamImage.mimeType};base64,${streamImage.data}`} /> : <p className="text-caption text-passive">{status?.error ?? t("emulator.startPrompt")}</p>}
		</div>
	);
}
