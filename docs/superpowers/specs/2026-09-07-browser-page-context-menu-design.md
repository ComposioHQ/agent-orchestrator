# AO Browser Page Context Menu Design

## Goal

Replace the operating-system-styled Electron menu used for browser-page right clicks with an AO-styled menu, without reintroducing the one-frame BrowserView blink. Add a **Save link as…** action for link targets while preserving contextual actions and immediate annotation target selection.

## Architecture

The menu will render inside the browsed page's existing isolated preload layer. Because the menu belongs to the same `WebContentsView` as the page, it naturally appears above page content and does not require hiding, resizing, or re-stacking the native view. The menu UI will live in a closed Shadow DOM root so page CSS cannot alter AO styling and the menu cannot alter the page's layout.

Electron's main process remains authoritative for available actions and execution. On Chromium's `context-menu` event, the browser host retains the target metadata and sends a bounded presentation payload—localized labels, supported actions, and viewport coordinates—to that tab's preload. The preload renders the menu and returns only the selected action or a dismissal event. Main-process request identity and active-tab checks prevent stale menus from executing.

## Appearance and Interaction

The menu uses AO's action-menu visual recipe: dark card surface, subtle border and shadow, eight-pixel radius, compact padding, muted text, AO hover treatment, and separators. It is positioned at the click point and clamped to the viewport. Escape, clicking outside, navigation, tab changes, and choosing an action dismiss it. Keyboard focus begins on the first item and supports arrow navigation, Enter/Space, and Escape.

## Actions

Existing contextual actions remain unchanged: Annotate, open link in a new AO tab, open in an external browser, copy link address, copy selected text, and inspect the clicked element.

**Save link as…** appears for any non-empty link URL that AO can safely request. Selecting it opens Electron's save dialog with a filename inferred from the URL. After the user chooses a location, the active tab starts the download through its own Electron session so its cookies and authentication are retained. The matching `will-download` event assigns the selected path. Canceling the dialog is a no-op; download or dialog errors do not leave a pending context-menu request.

Annotate continues to pass the original page coordinates into annotation mode. The annotation preload resolves the element at that point, locks its highlight, and opens the annotation prompt immediately.

## Security and Failure Handling

Only the active, visible tab may open or act on a menu. Each menu payload receives a unique request ID, and action/dismiss messages must match the retained request and sender `webContents`. URLs remain length-limited and are validated before open or save actions. The Shadow DOM UI contains text-only labels and no page-provided HTML.

If the save dialog is canceled, the URL is invalid, the tab changes, or the download cannot start, AO safely drops the request. The download listener removes itself after the matching download begins or the tab is destroyed.

## Testing

Tests will cover:

- main-process action availability and ordering, including **Save link as…** only on valid link targets;
- request/sender validation and stale-request rejection;
- save-dialog cancellation and authenticated-session download path assignment;
- preload rendering, AO styling contract, viewport clamping, keyboard/mouse dismissal, and action routing;
- retained right-click coordinates reaching annotation preselection;
- absence of the shell overlay signal that previously triggered BrowserView restacking.

Type checking and focused browser-host/preload/renderer tests must pass before the dev process is restarted from the worktree head.
