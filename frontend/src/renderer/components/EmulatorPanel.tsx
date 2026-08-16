import { Play, Square } from "lucide-react";
import type { MouseEvent } from "react";
import { useIOSSimulator } from "../hooks/useIOSSimulator";
import { isMacPlatform } from "../lib/platform";
import { Button } from "./ui/button";

export function EmulatorPanel({ active }: { active: boolean }) {
	const ios = useIOSSimulator(active && isMacPlatform());
	if (!active || !isMacPlatform()) return null;
	const status = ios.status.data;
	const image = ios.screenshot.data;
	const permissions = ios.permissions.data;
	const sendTap = (event: MouseEvent<HTMLImageElement>) => {
		const bounds = event.currentTarget.getBoundingClientRect();
		ios.input.mutate({ action: "tap", x: event.clientX - bounds.left, y: event.clientY - bounds.top });
	};
	return (
		<div className="flex flex-col gap-3 p-3" role="tabpanel" aria-label="iOS Simulator">
			<div className="flex items-center justify-between gap-2">
				<strong className="text-sm-md">iOS Simulator</strong>
				<div className="flex gap-2">
					<Button size="sm" type="button" onClick={() => ios.start.mutate()} disabled={ios.start.isPending || status?.state === "Booted"}>
						<Play className="mr-1 size-icon-2xs" />Start
					</Button>
					<Button size="sm" type="button" variant="outline" onClick={() => ios.stop.mutate()} disabled={ios.stop.isPending || status?.state !== "Booted"}>
						<Square className="mr-1 size-icon-2xs" />Stop
					</Button>
				</div>
			</div>
			{permissions && (!permissions.screenRecording || !permissions.accessibility) ? <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-caption text-passive">Grant Screen Recording and Accessibility access to AO in macOS System Settings to enable Simulator capture and input.</div> : null}
			{status?.state === "Booted" && image ? <img alt="iOS Simulator" className="w-full rounded border border-border" onClick={sendTap} src={`data:${image.mimeType};base64,${image.data}`} /> : <p className="text-caption text-passive">{status?.error ?? "Start the simulator to see its screen."}</p>}
		</div>
	);
}
