export type ScopedFontSizeShortcutEvent = Pick<
	KeyboardEvent,
	"altKey" | "code" | "ctrlKey" | "key" | "metaKey"
>;

/** Ctrl +/- resizes the focused surface while Cmd +/- remains application zoom. */
export function scopedFontSizeDelta(event: ScopedFontSizeShortcutEvent): -1 | 0 | 1 {
	if (!event.ctrlKey || event.metaKey || event.altKey) return 0;
	if (event.key === "+" || event.key === "=" || event.code === "NumpadAdd") return 1;
	if (event.key === "-" || event.code === "NumpadSubtract") return -1;
	return 0;
}
