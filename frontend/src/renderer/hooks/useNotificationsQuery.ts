import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { aoBridge } from "../lib/bridge";
import {
	clearAllCachedNotifications,
	clearAllNotifications,
	fetchNotificationsPage,
	markAllCachedNotificationsRead,
	markAllNotificationsRead,
	notificationsQueryKey,
	type NotificationListStatus,
	unreadNotificationsQueryKey,
} from "../lib/notifications";

export function useNotificationsQuery(status: NotificationListStatus, enabled = true) {
	return useInfiniteQuery({
		queryKey: notificationsQueryKey(status),
		queryFn: ({ pageParam }) => fetchNotificationsPage(status, pageParam),
		initialPageParam: "",
		getNextPageParam: (lastPage) => lastPage.nextCursor || undefined,
		enabled,
		retry: 1,
	});
}

/**
 * Opening the notification panel is the acknowledgement — there is no manual
 * "mark all read" control any more, so this mutation is fired on open.
 */
export function useMarkAllNotificationsReadMutation() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: markAllNotificationsRead,
		onSuccess: (updatedCount, ids) => {
			markAllCachedNotificationsRead(queryClient, ids, updatedCount);
			// Do not invalidate recent/all here: a refetch would drop loaded pages
			// and the cursor to unread rows the panel has not reached yet. The
			// cache is already correct for the ids we sent; updatedCount keeps the
			// unread badge in sync even when those ids only exist in the all list.
			if (ids.length === 0) {
				void queryClient.invalidateQueries({ queryKey: unreadNotificationsQueryKey });
			}
		},
	});
}

export function useClearAllNotificationsMutation() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: clearAllNotifications,
		// Cancelling only here narrows the window but does not close it: the SSE
		// stream reconnecting, a daemon base-URL change, or the panel re-opening
		// can all start a fresh GET after this point, while the DELETE is still
		// pending. That GET can then resolve after clearAllCachedNotifications
		// runs and repopulate the cache with rows that were just cleared.
		onMutate: async () => {
			await queryClient.cancelQueries({ queryKey: ["notifications", "history"] });
		},
		// Cancel again right before clearing the cache so anything that started
		// during the pending DELETE cannot win the race and overwrite the reset.
		onSuccess: async () => {
			await queryClient.cancelQueries({ queryKey: ["notifications", "history"] });
			clearAllCachedNotifications(queryClient);
			void aoBridge.notifications.setBadge(0);
		},
	});
}
