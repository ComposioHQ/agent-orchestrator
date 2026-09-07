export type BrowserPageContextMenuAction =
	| "annotate"
	| "open-link-tab"
	| "open-link-external"
	| "copy-link"
	| "save-link"
	| "copy-selection"
	| "inspect";

export type BrowserPageContextMenuItem =
	| { type: "action"; action: BrowserPageContextMenuAction; label: string }
	| { type: "separator" };

export type BrowserPageContextMenuPresentation = {
	requestId: string;
	position: { x: number; y: number };
	items: BrowserPageContextMenuItem[];
};

export type BrowserPageContextMenuActionInput = {
	requestId: string;
	action: BrowserPageContextMenuAction;
};

export type BrowserPageContextMenuDismissInput = {
	requestId: string;
};
