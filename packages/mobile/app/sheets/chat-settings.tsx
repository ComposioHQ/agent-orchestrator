import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ChatSettingsSheet } from "../../lib/chat/ChatSettingsModal";
import { readChatSheet, releaseChatSheet } from "../../lib/chat/chatSheetRegistry";

export default function ChatSettingsRoute() {
	const router = useRouter();
	const { sheetKey } = useLocalSearchParams<{ sheetKey?: string }>();
	const entry = readChatSheet(sheetKey);
	useEffect(() => () => releaseChatSheet(sheetKey), [sheetKey]);
	const [snapshot, setSnapshot] = useState(entry?.kind === "turn-settings" ? entry.snapshot : undefined);
	const [options, setOptions] = useState(entry?.kind === "turn-settings" ? entry.options : []);
	if (entry?.kind !== "turn-settings" || !snapshot) return <Unavailable onClose={() => router.back()} />;
	return <ChatSettingsSheet snapshot={snapshot} models={entry.models} options={options} disabled={entry.disabled} error={entry.error} onSettings={(settings) => { setSnapshot((current) => current ? { ...current, settings } : current); entry.onSettings(settings); }} onOption={(id, value) => { setOptions((current) => current.map((option) => option.id !== id ? option : "enabled" in value ? { ...option, currentBoolean: value.enabled } : { ...option, currentValue: value.value })); entry.onOption(id, value); }} />;
}

function Unavailable({ onClose }: { onClose(): void }) {
	useEffect(() => { const timer = setTimeout(onClose, 0); return () => clearTimeout(timer); }, [onClose]);
	return null;
}
