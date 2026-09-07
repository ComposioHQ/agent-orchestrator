export const BROWSER_CONTEXT_MENU_ACTIONS = [
	"open-link-tab",
	"open-link-external",
	"copy-link",
	"copy-selection",
	"inspect",
] as const;

export type BrowserContextMenuAction = (typeof BROWSER_CONTEXT_MENU_ACTIONS)[number];

export type BrowserContextMenuRequest = {
	requestId: string;
	viewId: string;
	tabId: string;
	position: { x: number; y: number };
	actions: BrowserContextMenuAction[];
};

export type BrowserContextMenuTargetInput = Pick<BrowserContextMenuRequest, "requestId" | "viewId" | "tabId">;

export type BrowserContextMenuActionInput = BrowserContextMenuTargetInput & {
	action: BrowserContextMenuAction;
};

export type BrowserContextMenuDismissInput = BrowserContextMenuTargetInput & {
	restoreFocus: boolean;
};
