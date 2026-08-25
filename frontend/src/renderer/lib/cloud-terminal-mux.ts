import type { CloudTerminalEvent } from "../../shared/cloud-beta";
import { aoBridge } from "./bridge";
import { base64ToBytes, type MuxConnectionState, type TerminalMux } from "./terminal-mux";

type Listener<T> = (value: T) => void;

function subscribe<T>(listeners: Set<Listener<T>>, listener: Listener<T>): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function createCloudTerminalMux(orgId: string, sessionId: string): TerminalMux {
	const connectionId = crypto.randomUUID();
	const dataListeners = new Set<Listener<Uint8Array>>();
	const exitListeners = new Set<Listener<void>>();
	const openedListeners = new Set<Listener<void>>();
	const errorListeners = new Set<Listener<string>>();
	const connectionListeners = new Set<Listener<MuxConnectionState>>();
	let disposed = false;

	const emit = (event: CloudTerminalEvent) => {
		if (disposed || event.connectionId !== connectionId) return;
		if (event.type === "data") {
			const bytes = base64ToBytes(event.data);
			for (const listener of dataListeners) listener(bytes);
		} else if (event.type === "opened") {
			for (const listener of openedListeners) listener();
		} else if (event.type === "exited") {
			for (const listener of exitListeners) listener();
		} else if (event.type === "error") {
			for (const listener of errorListeners) listener(event.message);
		} else {
			for (const listener of connectionListeners) listener(event.state);
		}
	};
	const unsubscribe = aoBridge.cloud.onTerminalEvent(emit);

	return {
		open: (id, cols, rows) => {
			if (disposed || id !== sessionId) return;
			void aoBridge.cloud.openTerminal({
				connectionId,
				orgId,
				sessionId,
				kind: "agent",
				cols,
				rows,
			}).catch((error: unknown) => {
				if (disposed) return;
				const message = error instanceof Error ? error.message : "Could not open the Cloud terminal.";
				for (const listener of errorListeners) listener(message);
			});
		},
		sendInput: (id, input) => {
			if (!disposed && id === sessionId) aoBridge.cloud.sendTerminalInput(connectionId, input);
		},
		resize: (id, cols, rows) => {
			if (!disposed && id === sessionId) aoBridge.cloud.resizeTerminal(connectionId, cols, rows);
		},
		close: (id) => {
			if (!disposed && id === sessionId) aoBridge.cloud.closeTerminal(connectionId);
		},
		onData: (id, listener) => id === sessionId ? subscribe(dataListeners, listener) : () => undefined,
		onExit: (id, listener) => id === sessionId ? subscribe(exitListeners, listener) : () => undefined,
		onOpened: (id, listener) => id === sessionId ? subscribe(openedListeners, listener) : () => undefined,
		onError: (id, listener) => id === sessionId ? subscribe(errorListeners, listener) : () => undefined,
		onConnectionChange: (listener) => subscribe(connectionListeners, listener),
		dispose: () => {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			aoBridge.cloud.closeTerminal(connectionId);
			dataListeners.clear();
			exitListeners.clear();
			openedListeners.clear();
			errorListeners.clear();
			connectionListeners.clear();
		},
	};
}
