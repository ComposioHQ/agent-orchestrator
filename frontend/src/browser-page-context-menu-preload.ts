import { ipcRenderer } from "electron";
import type {
	BrowserPageContextMenuActionInput,
	BrowserPageContextMenuDismissInput,
	BrowserPageContextMenuPresentation,
} from "./shared/browser-page-context-menu";

const HOST_ATTRIBUTE = "data-ao-browser-context-menu";
let active: { host: HTMLDivElement; requestId: string; removeListeners: () => void } | null = null;

function close(sendDismiss: boolean): void {
	const current = active;
	if (!current) return;
	active = null;
	current.removeListeners();
	current.host.remove();
	if (sendDismiss) {
		const payload: BrowserPageContextMenuDismissInput = { requestId: current.requestId };
		ipcRenderer.send("browser:pageContextMenu:dismiss", payload);
	}
}

function show(input: BrowserPageContextMenuPresentation): void {
	close(false);
	if (!input || typeof input.requestId !== "string" || !Array.isArray(input.items)) return;

	const host = document.createElement("div");
	host.setAttribute(HOST_ATTRIBUTE, "");
	host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:auto;";
	const root = host.attachShadow({ mode: "closed" });
	const menu = document.createElement("div");
	menu.setAttribute("role", "menu");
	menu.tabIndex = -1;
	Object.assign(menu.style, {
		position: "fixed",
		left: `${Math.max(8, input.position.x)}px`,
		top: `${Math.max(8, input.position.y)}px`,
		minWidth: "220px",
		maxWidth: "320px",
		padding: "4px",
		display: "flex",
		flexDirection: "column",
		gap: "1px",
		boxSizing: "border-box",
		border: "1px solid rgba(255, 255, 255, 0.14)",
		borderRadius: "8px",
		background: "rgb(28, 28, 30)",
		boxShadow: "0 14px 36px rgba(0, 0, 0, 0.45)",
		color: "rgba(255, 255, 255, 0.88)",
		fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
		fontSize: "14px",
		lineHeight: "20px",
		pointerEvents: "auto",
	});

	for (const item of input.items) {
		if (item.type === "separator") {
			const separator = document.createElement("div");
			separator.setAttribute("role", "separator");
			separator.style.cssText = "height:1px;margin:4px -4px;background:rgba(255,255,255,.12);";
			menu.appendChild(separator);
			continue;
		}
		const button = document.createElement("button");
		button.type = "button";
		button.setAttribute("role", "menuitem");
		button.dataset.action = item.action;
		button.textContent = item.label;
		button.style.cssText = [
			"appearance:none",
			"border:0",
			"border-radius:6px",
			"background:transparent",
			"color:inherit",
			"font:inherit",
			"text-align:left",
			"padding:7px 10px",
			"cursor:default",
			"outline:none",
		].join(";");
		button.addEventListener("mouseenter", () => {
			button.style.background = "rgba(255, 255, 255, 0.09)";
			button.style.color = "rgb(255, 255, 255)";
		});
		button.addEventListener("mouseleave", () => {
			if (document.activeElement !== button) button.style.background = "transparent";
		});
		button.addEventListener("focus", () => {
			button.style.background = "rgba(255, 255, 255, 0.09)";
			button.style.color = "rgb(255, 255, 255)";
		});
		button.addEventListener("blur", () => {
			button.style.background = "transparent";
		});
		button.addEventListener("click", () => {
			const payload: BrowserPageContextMenuActionInput = { requestId: input.requestId, action: item.action };
			close(false);
			ipcRenderer.send("browser:pageContextMenu:action", payload);
		});
		menu.appendChild(button);
	}

	root.appendChild(menu);
	document.documentElement.appendChild(host);

	const clamp = () => {
		const rect = menu.getBoundingClientRect();
		menu.style.left = `${Math.max(8, Math.min(input.position.x, window.innerWidth - rect.width - 8))}px`;
		menu.style.top = `${Math.max(8, Math.min(input.position.y, window.innerHeight - rect.height - 8))}px`;
	};
	clamp();

	const buttons = () => Array.from(menu.querySelectorAll<HTMLButtonElement>("button[role=menuitem]"));
	const onMenuPointerDown = (event: Event) => {
		event.stopPropagation();
	};
	const onBackdropPointerDown = (event: Event) => {
		event.preventDefault();
		event.stopPropagation();
		close(true);
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			close(true);
			return;
		}
		if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
		event.preventDefault();
		const items = buttons();
		if (items.length === 0) return;
		const current = items.indexOf(root.activeElement as HTMLButtonElement);
		const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown"
			? (current + 1 + items.length) % items.length
			: (current - 1 + items.length) % items.length;
		items[index]?.focus();
	};
	menu.addEventListener("pointerdown", onMenuPointerDown);
	host.addEventListener("pointerdown", onBackdropPointerDown);
	document.addEventListener("keydown", onKeyDown, true);
	active = {
		host,
		requestId: input.requestId,
		removeListeners: () => {
			menu.removeEventListener("pointerdown", onMenuPointerDown);
			host.removeEventListener("pointerdown", onBackdropPointerDown);
			document.removeEventListener("keydown", onKeyDown, true);
		},
	};
	buttons()[0]?.focus();
}

ipcRenderer.on("browser:pageContextMenu:show", (_event, input: BrowserPageContextMenuPresentation) => show(input));
ipcRenderer.on("browser:pageContextMenu:hide", () => close(false));
