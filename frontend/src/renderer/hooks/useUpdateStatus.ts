import { useEffect, useRef, useState } from "react";
import type { UpdateStatus } from "../../main/update-settings";
import { aoBridge } from "../lib/bridge";

/**
 * Live desktop update status: seeded from updates.getStatus, then streamed via
 * the updates:status push channel. Used by the sidebar restart-to-update row
 * and the Global Settings Updates section.
 *
 * Deliberately carries no telemetry. Two components mount this hook, so each
 * would report the same outcome, and the statuses it sees are the UI's view:
 * the main process suppresses them for automatic checks. Update telemetry is
 * owned by the main process and subscribed once in lib/update-telemetry.ts.
 */
export function useUpdateStatus(onStatusEvent?: (status: UpdateStatus) => void): UpdateStatus {
	const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });
	const onStatusEventRef = useRef(onStatusEvent);
	onStatusEventRef.current = onStatusEvent;
	useEffect(() => {
		let live = true;
		// A push that lands before the listener exists is gone for good, so the
		// listener is registered BEFORE the snapshot is requested.
		let pushed = false;
		const off = aoBridge.updates.onStatus((next) => {
			pushed = true;
			onStatusEventRef.current?.(next);
			setStatus(next);
		});
		void aoBridge.updates.getStatus().then((s) => {
			// And the snapshot is dropped once a live push has landed. It describes
			// the state at request time, so applying it late walked the UI backwards:
			// a completed check would arrive first and the older mount-time snapshot
			// would overwrite it, leaving "Last checked" stuck until Settings was
			// closed and reopened.
			if (!live || pushed) return;
			onStatusEventRef.current?.(s);
			setStatus(s);
		});
		return () => {
			live = false;
			off?.();
		};
	}, []);
	return status;
}
