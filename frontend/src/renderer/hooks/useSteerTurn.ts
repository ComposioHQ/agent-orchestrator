import { useCallback, useState } from "react";
import { getApiBaseUrl, apiErrorMessage } from "../lib/api-client";

type SteerResult = { ok: true; promotedTurn: unknown } | { ok: false; error: string; code?: string };

export function useSteerTurn(sessionId: string, turnId: string) {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const steer = useCallback(async (): Promise<SteerResult> => {
		setPending(true);
		setError(null);
		try {
			const base = getApiBaseUrl() || "";
			const res = await fetch(`${base}/api/v1/sessions/${encodeURIComponent(sessionId)}/conversation/turns/${encodeURIComponent(turnId)}/steer`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
			});
			if (!res.ok) {
				let code: string | undefined;
				let message = apiErrorMessage({ error: `HTTP ${res.status}` });
				try {
					const body = (await res.json()) as { code?: string; message?: string; error?: string };
					code = body.code;
					if (body.message) message = body.message;
					else if (body.error) message = body.error;
				} catch {
					// keep generic
				}
				if (res.status === 404 && code === "TURN_NOT_FOUND") message = "Turn not found — it may have already been handled.";
				else if (res.status === 409 && code === "TURN_NOT_QUEUED") message = "Turn is no longer queued.";
				else if (res.status === 409 && code === "NO_STEERABLE_TURN") message = "No steerable turn is running — wait for the agent to be active.";
				else if (res.status === 400 && code === "UNSUPPORTED_ATTACHMENT") message = "This harness cannot steer attachments — try text only.";
				setError(message);
				return { ok: false, error: message, code };
			}
			const data = (await res.json()) as { promotedTurn: unknown };
			return { ok: true, promotedTurn: data.promotedTurn };
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			setError(msg);
			return { ok: false, error: msg };
		} finally {
			setPending(false);
		}
	}, [sessionId, turnId]);

	return { steer, pending, error, setError };
}
