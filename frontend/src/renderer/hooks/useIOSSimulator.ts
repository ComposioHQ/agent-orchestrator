import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiClient, apiErrorMessage, getApiBaseUrl, subscribeApiBaseUrl } from "../lib/api-client";

export type StreamFrame = {
	data: string;
	mimeType: string;
	width?: number;
	height?: number;
};

/** Connection state of the live frame WebSocket. */
export type StreamState = "idle" | "connecting" | "live" | "stalled";

type StreamMessage = { data?: string; mimeType?: string; width?: number; height?: number; error?: string };

// WebSocket reconnect backoff: 1s, 2s, 4s, capped at 8s.
const WS_RECONNECT_BASE_MS = 1000;
const WS_RECONNECT_MAX_MS = 8000;

export function useIOSSimulator(enabled: boolean) {
	const queryClient = useQueryClient();
	const [streamFrame, setStreamFrame] = useState<StreamFrame | null>(null);
	const [streamState, setStreamState] = useState<StreamState>("idle");
	const [streamError, setStreamError] = useState<string | null>(null);

	const status = useQuery({
		queryKey: ["ios-device", "status"],
		queryFn: async () => {
			const response = await apiClient.GET("/api/v1/ios-device/status");
			if (response.error) throw new Error(apiErrorMessage(response.error, "Failed to read iOS Simulator status"));
			return response.data;
		},
		enabled,
		refetchInterval: 2000,
	});
	// Toolchain (Xcode/runtime) state drives the "load needed dependencies"
	// flow — without Xcode there is nothing to boot.
	const toolchain = useQuery({
		queryKey: ["ios-device", "toolchain"],
		queryFn: async () => {
			const response = await apiClient.GET("/api/v1/ios-device/toolchain/status");
			if (response.error) throw new Error(apiErrorMessage(response.error, "Failed to read iOS toolchain status"));
			return response.data;
		},
		enabled,
		refetchInterval: 10_000,
	});
	const recheck = useMutation({
		mutationFn: async () => {
			const response = await apiClient.POST("/api/v1/ios-device/toolchain/recheck");
			if (response.error) throw new Error(apiErrorMessage(response.error, "Failed to recheck iOS toolchain"));
			return response.data;
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["ios-device", "toolchain"] });
		},
	});
	const start = useMutation({
		mutationFn: async () => {
			const response = await apiClient.POST("/api/v1/ios-device/start");
			if (response.error) throw new Error(apiErrorMessage(response.error, "Failed to start iOS Simulator"));
			return response.data;
		},
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["ios-device", "status"] }),
	});
	const stop = useMutation({
		mutationFn: async () => {
			const response = await apiClient.POST("/api/v1/ios-device/stop");
			if (response.error) throw new Error(apiErrorMessage(response.error, "Failed to stop iOS Simulator"));
			return response.data;
		},
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["ios-device", "status"] }),
	});
	// Screenshot poll is only the fallback: live frames arrive over the
	// WebSocket; the 1s REST poll keeps the panel usable where ScreenCaptureKit
	// is unavailable (headless helpers, restricted environments).
	const screenshot = useQuery({
		queryKey: ["ios-device", "screenshot"],
		queryFn: async () => {
			const response = await apiClient.GET("/api/v1/ios-device/screenshot");
			if (response.error) throw new Error(apiErrorMessage(response.error, "Failed to capture iOS Simulator"));
			return response.data;
		},
		enabled: enabled && status.data?.state === "Booted" && streamState !== "live",
		refetchInterval: 1000,
	});
	const permissions = useQuery({
		queryKey: ["ios-device", "permissions"],
		queryFn: async () => {
			const response = await apiClient.GET("/api/v1/ios-device/permissions");
			return response.data;
		},
		enabled,
		refetchInterval: 5000,
	});

	// Live frame stream with reconnect. One socket at a time; on close or error
	// it reconnects with exponential backoff, and when the daemon's base URL
	// changes (daemon restarted on another port) the open socket is dropped so
	// the reconnection logic picks up the new base URL.
	useEffect(() => {
		if (!enabled) {
			setStreamFrame(null);
			setStreamState("idle");
			setStreamError(null);
			return;
		}
		let disposed = false;
		let socket: WebSocket | null = null;
		let retryCount = 0;
		let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

		const closeSocket = () => {
			if (socket) {
				// Prevent the onclose handler from scheduling another reconnect
				// for an intentionally closed socket.
				socket.onclose = null;
				socket.close();
				socket = null;
			}
		};
		const scheduleReconnect = () => {
			if (disposed) return;
			const delay = Math.min(WS_RECONNECT_BASE_MS * 2 ** retryCount, WS_RECONNECT_MAX_MS);
			retryCount += 1;
			reconnectTimer = setTimeout(() => {
				reconnectTimer = undefined;
				connect();
			}, delay);
		};
		const connect = () => {
			if (disposed) return;
			const base = getApiBaseUrl();
			if (!base) {
				scheduleReconnect();
				return;
			}
			setStreamError(null);
			setStreamState((current) => (current === "live" ? current : "connecting"));
			socket = new WebSocket(`${base.replace(/^http/, "ws")}/api/v1/ios-device/stream`);
			socket.onopen = () => {
				if (disposed) return;
				retryCount = 0;
			};
			socket.onmessage = (event) => {
				let message: StreamMessage;
				try {
					message = JSON.parse(event.data) as StreamMessage;
				} catch {
					return; // malformed frames are ignored
				}
				if (message.error) {
					setStreamState("stalled");
					setStreamError(message.error);
					return;
				}
				if (message.data && message.mimeType) {
					setStreamError(null);
					setStreamState("live");
					setStreamFrame({ data: message.data, mimeType: message.mimeType, width: message.width, height: message.height });
				}
			};
			socket.onerror = () => {
				// onclose does the reconnect scheduling.
				socket?.close();
			};
			socket.onclose = () => {
				if (disposed) return;
				socket = null;
				setStreamState("stalled");
				scheduleReconnect();
			};
		};

		const unsubscribeBaseUrl = subscribeApiBaseUrl(() => {
			// The daemon moved (or the renderer learned a trusted URL): drop the
			// socket so the next connect uses the new base URL.
			closeSocket();
		});

		connect();
		return () => {
			disposed = true;
			unsubscribeBaseUrl();
			if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
			closeSocket();
		};
	}, [enabled]);

	const input = useMutation({
		mutationFn: async (
			request:
				| { action: "tap" | "swipe"; x: number; y: number; x2?: number; y2?: number }
				| { action: "text"; text: string }
				| { action: "key"; keyCode: number }
				| { action: "home" | "lock" | "rotateLeft" | "rotateRight" },
		) => {
			const response = await apiClient.POST("/api/v1/ios-device/input", { body: request });
			if (response.error) throw new Error(apiErrorMessage(response.error, "Failed to send iOS Simulator input"));
			return response.data;
		},
	});
	return {
		status,
		toolchain,
		recheck,
		start,
		stop,
		screenshot,
		streamFrame,
		streamState,
		streamError,
		permissions,
		input,
	};
}