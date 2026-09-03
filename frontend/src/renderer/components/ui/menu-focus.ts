import { useCallback } from "react";

/**
 * Focus hand-off between a menu that is closing and the surface its selected
 * item opened.
 *
 * Radix restores focus after a menu closes, but it defers that restore by a
 * tick (FocusScope dispatches its unmount handler from a `setTimeout`). When
 * the selected item opened a dialog, the dialog has already claimed the caret
 * by then, and the late restore yanks it back out, so the user lands in a
 * composer with no cursor in it.
 *
 * A menu that closes without opening anything leaves focus on `document.body`,
 * so "something outside the menu already holds focus" is a reliable signal that
 * another surface owns the caret. Only then is the restore skipped; Escape and
 * plain item selection keep Radix's normal return-to-trigger behaviour that
 * keyboard users depend on.
 *
 * Skipping it would stop there, except that the dialog cannot return focus for
 * us: Radix captured its return target when the dialog mounted, and that was
 * the menu item, which no longer exists. So the return target is captured when
 * the menu opens and handed back once the surface that borrowed the caret lets
 * go of it.
 */

// Only one menu is open at a time, so a single slot each is enough.
let menuReturnTarget: HTMLElement | null = null;
let capturedForMenu: HTMLElement | null = null;
let pendingReturnTarget: HTMLElement | null = null;
let watchingForRelease = false;

/**
 * Remember, while the menu is open, where focus should end up once it is done
 * with it. A dropdown returns to its trigger, which is only discoverable by its
 * `aria-controls` link while the menu is open; a context menu has no such
 * trigger, so it falls back to whatever the user was on before right-clicking.
 * Both are the element Radix itself would have returned to.
 */
export function useMenuReturnTarget<T extends HTMLElement>() {
	return useCallback((menu: T | null) => {
		// The node attaches when the menu opens and detaches when it closes. Radix
		// recomposes its own refs on every render, so this fires repeatedly for the
		// same element; only the first call is the moment the menu opened, and a
		// later one would read the surface the selected item just opened instead.
		if (!menu || capturedForMenu === menu) return;
		capturedForMenu = menu;
		// Read once the commit has settled: the trigger's `aria-controls` link only
		// exists while the menu is open, and Radix has not moved focus yet because
		// it does that from a passive effect.
		queueMicrotask(() => {
			const trigger = menu.id
				? menu.ownerDocument.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(menu.id)}"]`)
				: null;
			const active = document.activeElement;
			menuReturnTarget =
				trigger ?? (active instanceof HTMLElement && active !== document.body ? active : null);
		});
	}, []);
}

export function keepFocusOnOpenedSurface(event: Event) {
	if (event.defaultPrevented) return;
	const active = document.activeElement;
	if (!active || active === document.body) return;
	const menu = event.currentTarget ?? event.target;
	if (menu instanceof Node && menu.contains(active)) return;
	event.preventDefault();
	returnFocusWhenSurfaceCloses();
}

function returnFocusWhenSurfaceCloses() {
	pendingReturnTarget = menuReturnTarget;
	if (!pendingReturnTarget || watchingForRelease) return;
	watchingForRelease = true;
	document.addEventListener("focusout", handleFocusRelease, true);
}

function handleFocusRelease(event: FocusEvent) {
	// Focus moving to another element is the user's business. Only a null
	// relatedTarget means it fell through to nowhere, which is what happens when
	// the dialog that borrowed the caret unmounts.
	if (event.relatedTarget !== null) return;
	const target = pendingReturnTarget;
	if (!target) return;
	// Two frames, not one tick: the surface the dialog was covering gets first
	// claim on the caret through its own effects. A worker terminal, for one,
	// re-enables input as the dialog closes and focuses itself, and it is a
	// better landing spot than the menu trigger. This hand-back is only the
	// fallback for focus that would otherwise be stranded on `document.body`.
	requestAnimationFrame(() =>
		requestAnimationFrame(() => {
			if (pendingReturnTarget !== target || document.activeElement !== document.body) return;
			pendingReturnTarget = null;
			if (target.isConnected) target.focus();
		}),
	);
}

/** Runs the caller's own handler first, then the hand-off guard. */
export function composeMenuCloseAutoFocus(handler?: (event: Event) => void) {
	return (event: Event) => {
		handler?.(event);
		keepFocusOnOpenedSurface(event);
	};
}


