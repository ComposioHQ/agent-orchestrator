import { useEffect, useRef } from "react";

/**
 * Radix refocuses a dropdown's trigger when it closes. Chromium's
 * :focus-visible heuristic treats that async re-focus as keyboard-style even
 * after a mouse click, leaving a stray ring. Suppressing the refocus
 * unconditionally fixes the mouse case but breaks keyboard users, who expect
 * focus to return to the trigger after Escape or selecting an item with
 * Enter. Only suppress it when the close was actually triggered by a
 * pointer interaction (item click, outside click) — keyboard closes keep
 * Radix's normal focus-restore, so the ring shows correctly for those users.
 */
export function useSuppressStrayFocusRing(open: boolean) {
	const closedByPointerRef = useRef(false);
	useEffect(() => {
		if (!open) return;
		closedByPointerRef.current = false;
		const markPointer = () => {
			closedByPointerRef.current = true;
		};
		document.addEventListener("pointerdown", markPointer, true);
		return () => document.removeEventListener("pointerdown", markPointer, true);
	}, [open]);

	return (event: Event) => {
		if (closedByPointerRef.current) event.preventDefault();
	};
}
