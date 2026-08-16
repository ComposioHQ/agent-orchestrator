import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient, apiErrorMessage } from "../lib/api-client";

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
			if (response.error) throw new Error(apiErrorMessage(response.error, "Failed to read macOS permissions"));
			return response.data;
		},
		enabled,
		refetchInterval: 5000,
	});
	const input = useMutation({
		mutationFn: async (request: { action: "tap" | "swipe" | "text" | "key"; x?: number; y?: number; text?: string; keyCode?: number }) => {
			const response = await apiClient.POST("/api/v1/ios-device/input", { body: request });
			if (response.error) throw new Error(apiErrorMessage(response.error, "Failed to send iOS Simulator input"));
			return response.data;
		},
	});
	return { status, start, stop, screenshot, permissions, input };
}
