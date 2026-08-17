import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiClient, apiErrorMessage, getApiBaseUrl } from "../lib/api-client";

export function useIOSSimulator(enabled: boolean) {
	const queryClient = useQueryClient();
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
	const screenshot = useQuery({
		queryKey: ["ios-device", "screenshot"],
		queryFn: async () => {
			const response = await apiClient.GET("/api/v1/ios-device/screenshot");
			if (response.error) throw new Error(apiErrorMessage(response.error, "Failed to capture iOS Simulator"));
			return response.data;
		},
		enabled: enabled && status.data?.state === "Booted",
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
	const [streamFrame, setStreamFrame] = useState<{ data: string; mimeType: string } | null>(null);
	useEffect(() => {
		if (!enabled) return;
		const base = getApiBaseUrl(); if (!base) return;
		const socket = new WebSocket(`${base.replace(/^http/, "ws")}/api/v1/ios-device/stream`);
		socket.onmessage = (event) => { try { const frame = JSON.parse(event.data) as { data?: string; mimeType?: string }; if (frame.data && frame.mimeType) setStreamFrame({ data: frame.data, mimeType: frame.mimeType }); } catch { /* ignore malformed frames */ } };
		return () => socket.close();
	}, [enabled]);
	const input = useMutation({
		mutationFn: async (request: { action: "tap" | "swipe" | "text" | "key"; x?: number; y?: number; x2?: number; y2?: number; text?: string; keyCode?: number }) => {
			const response = await apiClient.POST("/api/v1/ios-device/input", { body: request });
			if (response.error) throw new Error(apiErrorMessage(response.error, "Failed to send iOS Simulator input"));
			return response.data;
		},
	});
	return { status, toolchain, recheck, start, stop, screenshot, streamFrame, permissions, input };
}
