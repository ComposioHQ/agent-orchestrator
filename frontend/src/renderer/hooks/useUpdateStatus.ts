import { useEffect, useRef, useSyncExternalStore } from "react";
import type { UpdateStatus } from "../../main/update-settings";
import { aoBridge } from "../lib/bridge";

const IDLE_STATUS: UpdateStatus = { state: "idle" };
let currentStatus = IDLE_STATUS;
let statusEventRevision = 0;
let connectionRevision = 0;
let removeStatusListener: (() => void) | undefined;
const storeListeners = new Set<() => void>();
const eventListeners = new Set<(status: UpdateStatus) => void>();

function publishStatus(status: UpdateStatus): void {
	currentStatus = status;
	for (const listener of eventListeners) listener(status);
	for (const listener of storeListeners) listener();
}

function connect(): void {
	if (removeStatusListener) return;
	const connection = ++connectionRevision;
	const snapshotRevision = statusEventRevision;
	removeStatusListener = aoBridge.updates.onStatus((status) => {
		if (connection !== connectionRevision) return;
		statusEventRevision += 1;
		publishStatus(status);
	});
	void aoBridge.updates.getStatus().then((status) => {
		// The IPC snapshot is requested after the push listener is installed. If
		// a newer push wins while that request is in flight, never let the older
		// snapshot roll the shared store (and Last checked) backward.
		if (connection !== connectionRevision || statusEventRevision !== snapshotRevision) return;
		publishStatus(status);
	});
}

function subscribe(listener: () => void): () => void {
	storeListeners.add(listener);
	connect();
	return () => {
		storeListeners.delete(listener);
		if (storeListeners.size !== 0) return;
		connectionRevision += 1;
		removeStatusListener?.();
		removeStatusListener = undefined;
		statusEventRevision = 0;
		currentStatus = IDLE_STATUS;
	};
}

function getSnapshot(): UpdateStatus {
	return currentStatus;
}

/**
 * Live desktop update status, shared by Settings and the sidebar. The store
 * subscribes before requesting its initial IPC snapshot and rejects that
 * snapshot if a newer push arrives first, so async hydration cannot overwrite
 * a completed check/download event with stale state.
 *
 * Deliberately carries no telemetry. Two components mount this hook, so each
 * would report the same outcome, and the statuses it sees are the UI's view:
 * the main process suppresses them for automatic checks. Update telemetry is
 * owned by the main process and subscribed once in lib/update-telemetry.ts.
 */
export function useUpdateStatus(onStatusEvent?: (status: UpdateStatus) => void): UpdateStatus {
	const onStatusEventRef = useRef(onStatusEvent);
	onStatusEventRef.current = onStatusEvent;
	const status = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
	useEffect(() => {
		const listener = (next: UpdateStatus) => onStatusEventRef.current?.(next);
		eventListeners.add(listener);
		return () => void eventListeners.delete(listener);
	}, []);
	return status;
}
