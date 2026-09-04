import React from "react";
import { describe, expect, it, vi } from "vitest";
vi.mock("react-native", () => ({ ActivityIndicator: "ActivityIndicator", Pressable: "Pressable", ScrollView: "ScrollView", Switch: "Switch", Text: "Text", View: "View", StyleSheet: { create: (value: unknown) => value } }));
vi.mock("@expo/vector-icons", () => ({ Feather: "Feather" }));
vi.mock("../haptics", () => ({ haptics: { tap: vi.fn() } }));
vi.mock("../ThemeProvider", () => ({ useTheme: () => ({}), useThemedStyles: () => ({}) }));
vi.mock("../ui", () => ({ SheetHeader: "SheetHeader" }));
import { ChatSettingsSheet } from "./ChatSettingsModal";
import type { ConversationSnapshot } from "./types";

// Inspect rendered Choice props without loading native host components.
function choices(node: React.ReactNode): Record<string, unknown>[] {
	return React.Children.toArray(node).flatMap((child) => {
		if (!React.isValidElement(child)) return [];
		const props = child.props as Record<string, unknown>;
		return [...(typeof props.label === "string" ? [props] : []), ...choices(props.children as React.ReactNode)];
	});
}

describe("model identity in mobile settings", () => {
	it.each([true, false])("preserves unlisted model with empty catalog=%s", (empty) => {
		const snapshot = { settings: { model: "gpt-6-astra" }, capabilities: [] } as unknown as ConversationSnapshot;
		const tree = ChatSettingsSheet({ snapshot, models: empty ? [] : [{ id: "terra", displayName: "Terra", default: true, efforts: ["high"], defaultEffort: "high" }], options: [], onRefresh: vi.fn(), onSettings: vi.fn(), onOption: vi.fn() });
		const rows = choices(tree);
		expect(rows.find((row) => row.label === "gpt-6-astra")).toMatchObject({ selected: true, disabled: true });
		expect(rows.find((row) => row.label === "Terra")?.selected).toBeFalsy();
		expect(rows.some((row) => row.label === "High")).toBe(false);
	});
});
