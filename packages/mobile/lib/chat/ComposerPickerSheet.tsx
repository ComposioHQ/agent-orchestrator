import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useMemo, useState } from "react";
import type { RankedSuggestion } from "./composerSuggestions";
import type { Theme } from "../theme";
import { useTheme, useThemedStyles } from "../ThemeProvider";
import { SheetHeader } from "../ui";
import { composerSheetContentStyle } from "./chatLayout";
import { haptics } from "../haptics";

export function ComposerPickerSheet({ kind, choices, truncated, onSelect }: { kind: "skills" | "files"; choices: RankedSuggestion[]; truncated?: boolean; onSelect(value: string): void }) {
	const t = useTheme(); const styles = useThemedStyles(makeStyles); const [query, setQuery] = useState("");
	const filtered = useMemo(() => { const needle = query.trim().toLowerCase(); return needle ? choices.filter((choice) => `${choice.label} ${choice.detail ?? ""} ${choice.value}`.toLowerCase().includes(needle)) : choices; }, [choices, query]);
	return <ScrollView style={styles.screen} contentContainerStyle={composerSheetContentStyle} keyboardShouldPersistTaps="handled"><SheetHeader title={kind === "skills" ? "Skills" : "Worktree files"} subtitle={kind === "skills" ? "Insert a skill into your message." : "Mention a file from this worktree."} /><TextInput value={query} onChangeText={setQuery} placeholder={kind === "skills" ? "Find a skill" : "Find a file"} placeholderTextColor={t.textFaint} style={styles.search} />{kind === "files" && truncated ? <Text style={styles.notice}>Showing the daemon's capped path list. Narrow your search or type a path directly.</Text> : null}{filtered.map((choice) => <Pressable key={choice.value} onPress={() => { haptics.select(); onSelect(choice.value); }} style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}><View style={{ flex: 1 }}><Text style={styles.label}>{choice.label}</Text>{choice.detail ? <Text numberOfLines={2} style={styles.detail}>{choice.detail}</Text> : null}</View>{choice.badge ? <Text style={styles.badge}>{choice.badge}</Text> : null}</Pressable>)}{!filtered.length ? <Text style={styles.empty}>No matches</Text> : null}</ScrollView>;
}
const makeStyles = (t: Theme) => StyleSheet.create({ screen: { flex: 1, backgroundColor: t.bgSurface }, search: { minHeight: 38, color: t.textPrimary, paddingHorizontal: 12, marginTop: 10 , borderBottomWidth: 2 , borderBottomColor : t.borderDefault }, notice: { color: t.amber, fontSize: 11, lineHeight: 16, marginBottom: 8 }, row: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 9 }, label: { color: t.textPrimary, fontSize: 14, fontWeight: "600" }, detail: { color: t.textTertiary, fontSize: 11, marginTop: 2 }, badge: { color: t.textTertiary, fontSize: 9 }, empty: { color: t.textTertiary, textAlign: "center", paddingVertical: 28 } });
