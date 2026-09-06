import { useCallback, useEffect, useState } from "react";
import type { BrowserDownload, BrowserDownloadAction } from "../../shared/browser-downloads";
import { aoBridge } from "../lib/bridge";

export function useBrowserDownloads() {
	const bridge = aoBridge.browser?.downloads;
	const [downloads, setDownloads] = useState<BrowserDownload[]>([]);
	const [error, setError] = useState("");

	useEffect(() => {
		if (!bridge) {
			setDownloads([]);
			return;
		}
		let active = true;
		void bridge.list().then((state) => active && setDownloads(state.downloads)).catch((reason) => {
			if (active) setError(reason instanceof Error ? reason.message : String(reason));
		});
		const unsubscribe = bridge.onChanged((state) => {
			setDownloads(state.downloads);
			setError("");
		});
		return () => {
			active = false;
			unsubscribe();
		};
	}, [bridge]);

	const action = useCallback(async (id: string, nextAction: BrowserDownloadAction) => {
		if (!bridge) return;
		try {
			const state = await bridge.action({ id, action: nextAction });
			setDownloads(state.downloads);
			setError("");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	}, [bridge]);

	const clear = useCallback(async () => {
		if (!bridge) return;
		try {
			const state = await bridge.clear();
			setDownloads(state.downloads);
			setError("");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	}, [bridge]);

	return { downloads, error, action, clear };
}
