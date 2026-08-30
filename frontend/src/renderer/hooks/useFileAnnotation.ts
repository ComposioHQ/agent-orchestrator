import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatFileAnnotationMessage } from "../../shared/file-annotations";
import { apiErrorMessage } from "../lib/api-client";
import { clientFor } from "../lib/host-clients";
import { LOCAL_HOST, type HostId } from "../lib/hosts";
import type { ActiveFileAnnotationTarget, FileAnnotationModel, FileAnnotationStatus } from "../components/WorkspaceDiffView";

export function useFileAnnotation(
	sessionId: string,
	// Defaults to the local daemon; SessionFileExplorer has no Ref yet. a8a2 threads it.
	host: HostId = LOCAL_HOST,
): FileAnnotationModel {
	const { t } = useTranslation();
	const [target, setTarget] = useState<ActiveFileAnnotationTarget | null>(null);
	const [draft, setDraft] = useState("");
	const [status, setStatus] = useState<FileAnnotationStatus>("idle");
	const [error, setError] = useState("");
	const generationRef = useRef(0);
	const sentTimerRef = useRef<number | null>(null);

	const cancel = () => {
		generationRef.current += 1;
		setTarget(null);
		setDraft("");
		setStatus("idle");
		setError("");
	};

	useEffect(() => {
		cancel();
	}, [host, sessionId]);
	useEffect(
		() => () => {
			if (sentTimerRef.current !== null) window.clearTimeout(sentTimerRef.current);
		},
		[],
	);

	const begin = (nextTarget: ActiveFileAnnotationTarget) => {
		generationRef.current += 1;
		if (sentTimerRef.current !== null) window.clearTimeout(sentTimerRef.current);
		sentTimerRef.current = null;
		setTarget(nextTarget);
		setDraft("");
		setStatus("idle");
		setError("");
	};
	const submit = async () => {
		if (!target || !draft.trim() || status === "sending") return;
		const generation = generationRef.current;
		setStatus("sending");
		setError("");
		try {
			const { error: responseError } = await clientFor(host).POST("/api/v1/sessions/{sessionId}/send", {
				params: { path: { sessionId } },
				body: { message: formatFileAnnotationMessage(target, draft) },
			});
			if (generation !== generationRef.current) return;
			if (responseError) throw new Error(apiErrorMessage(responseError, t("files.feedbackError")));
			setStatus("sent");
			sentTimerRef.current = window.setTimeout(() => {
				sentTimerRef.current = null;
				cancel();
			}, 1_200);
		} catch (submitError) {
			if (generation !== generationRef.current) return;
			setStatus("error");
			setError(apiErrorMessage(submitError, t("files.feedbackError")));
		}
	};

	return { target, draft, status, error, begin, setDraft, cancel, submit };
}
