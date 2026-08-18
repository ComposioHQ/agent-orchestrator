import { useEffect, useRef, useState } from "react";
import { androidStreamUrlFromApiBase } from "../lib/android-stream";
import { createAndroidFrameStream } from "../lib/android-frame-stream";
import { getApiBaseUrl } from "../lib/api-client";

/**
 * Live view of AO's shared Android emulator screen: connects to the frame
 * relay WebSocket while enabled, exposing the latest frame as an object URL
 * an <img> can point at directly. Object URLs are revoked as each new frame
 * replaces the last, and on disconnect, so this never leaks blobs.
 */
export function useAndroidFrameStream(enabled: boolean): { frameUrl: string | null; connected: boolean } {
	const [frameUrl, setFrameUrl] = useState<string | null>(null);
	const [connected, setConnected] = useState(false);
	const frameUrlRef = useRef<string | null>(null);

	useEffect(() => {
		if (!enabled) return undefined;

		const stream = createAndroidFrameStream(
			androidStreamUrlFromApiBase(getApiBaseUrl()),
			(data) => {
				const next = URL.createObjectURL(new Blob([data], { type: "image/png" }));
				if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current);
				frameUrlRef.current = next;
				setFrameUrl(next);
			},
			setConnected,
		);

		return () => {
			stream.close();
			if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current);
			frameUrlRef.current = null;
			setFrameUrl(null);
			setConnected(false);
		};
	}, [enabled]);

	return { frameUrl, connected };
}
