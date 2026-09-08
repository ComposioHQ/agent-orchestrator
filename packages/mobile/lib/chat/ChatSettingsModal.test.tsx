import React from "react";
import { describe, expect, it, vi } from "vitest";
vi.mock("react", async () => ({ ...await vi.importActual<typeof import("react")>("react"), useState: () => [null, vi.fn()] }));
vi.mock("react-native", () => ({ ActivityIndicator: "ActivityIndicator", Pressable: "Pressable", ScrollView: "ScrollView", Switch: "Switch", Text: "Text", View: "View", StyleSheet: { create: (value: unknown) => value } }));
vi.mock("@expo/vector-icons", () => ({ Feather: "Feather" }));
vi.mock("../haptics", () => ({ haptics: { tap: vi.fn(), select: vi.fn() } }));
vi.mock("../ThemeProvider", () => ({ useTheme: () => ({}), useThemedStyles: () => ({}) }));
vi.mock("../ui", () => ({ SheetHeader: "SheetHeader" }));
import { ChatSettingsSheet } from "./ChatSettingsModal";
import type { ConversationSnapshot } from "./types";

// Inspect rendered Choice props without loading native host components.
function choices(node: React.ReactNode): Record<string, unknown>[] {
	return React.Children.toArray(node).flatMap((child) => {
		if (!React.isValidElement(child)) return [];
		const props = child.props as Record<string, unknown>;
		return [...(typeof props.label === "string" || props.accessibilityRole === "radio" ? [props] : []), ...choices(typeof child.type === "function" ? (child.type as (props: Record<string, unknown>) => React.ReactNode)(props) : props.children as React.ReactNode)];
	});
}

describe("model identity in mobile settings", () => {
	it("does not mark the catalog default as the native configured model", () => {
		const snapshot = { settings: {}, capabilities: [] } as unknown as ConversationSnapshot;
		const rows = choices(ChatSettingsSheet({ snapshot, models: [{ id: "terra", displayName: "Terra", default: true, efforts: ["high"], defaultEffort: "high" }], options: [], onRefresh: vi.fn(), onSettings: vi.fn(), onOption: vi.fn() }));
		expect(rows.find((row) => row.label === "Provider default")).toMatchObject({ selected: true });
		expect(rows.find((row) => row.label === "Terra")?.selected).toBeFalsy();
		expect(rows.some((row) => row.label === "High")).toBe(false);
	});

	it("keeps an explicit effort visible when the model is unresolved", () => {
		const snapshot = { settings: { reasoningEffort: "high" }, capabilities: [] } as unknown as ConversationSnapshot;
		const rows = choices(ChatSettingsSheet({ snapshot, models: [], options: [], onRefresh: vi.fn(), onSettings: vi.fn(), onOption: vi.fn() }));
		expect(rows.find((row) => row.label === "High")).toMatchObject({ selected: true, disabled: true, hint: "Requested effort" });
	});

	it.each([true, false])("preserves unlisted model with empty catalog=%s", (empty) => {
		const snapshot = { settings: { model: "gpt-6-astra" }, capabilities: [] } as unknown as ConversationSnapshot;
		const tree = ChatSettingsSheet({ snapshot, models: empty ? [] : [{ id: "terra", displayName: "Terra", default: true, efforts: ["high"], defaultEffort: "high" }], options: [], onRefresh: vi.fn(), onSettings: vi.fn(), onOption: vi.fn() });
		const rows = choices(tree);
		expect(rows.find((row) => row.label === "gpt-6-astra")).toMatchObject({ selected: true, disabled: true });
		expect(rows.find((row) => row.label === "Terra")?.selected).toBeFalsy();
		expect(rows.some((row) => row.label === "High")).toBe(false);
	});
});


it("allows resetting the native model and effort while retaining approval", () => {
	const onSettings = vi.fn();
	const snapshot = { settings: { model: "nano", reasoningEffort: "high", approvalMode: "accept-edits" }, capabilities: [] } as unknown as ConversationSnapshot;
	const rows = choices(ChatSettingsSheet({ snapshot, models: [], options: [], onRefresh: vi.fn(), onSettings, onOption: vi.fn() }));
	const reset = rows.find((row) => row.label === "Provider default");
	expect(reset).toMatchObject({ selected: false });
	expect(reset?.disabled).toBeFalsy();
	(reset?.onPress as () => void)();
	expect(onSettings).toHaveBeenCalledWith({ model: undefined, reasoningEffort: undefined, approvalMode: "accept-edits" });
});

it("gives model radios a friendly label without the opaque provider id", () => {
	const snapshot = { settings: {}, capabilities: [] } as unknown as ConversationSnapshot;
	const rows = choices(ChatSettingsSheet({ snapshot, models: [{ id: "anthropic/claude-opus-5", displayName: "Opus 5", default: false, efforts: [] }], options: [], onRefresh: vi.fn(), onSettings: vi.fn(), onOption: vi.fn() }));
	expect(rows.find((row) => row.accessibilityRole === "radio" && row.accessibilityLabel === "Opus 5")).toBeDefined();
});
