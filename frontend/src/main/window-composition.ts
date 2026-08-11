import type { BaseWindow, WebContents, WebContentsView } from "electron";

type MainWindowHost = Pick<BaseWindow, "contentView" | "isDestroyed">;

export type WebContentsViewConstructor = new (options: {
	webPreferences: Electron.WebPreferences;
}) => WebContentsView;

export type WindowComposition = {
	shellView: WebContentsView;
	shellWebContents: WebContents;
	setOverlayOpen: (open: boolean) => void;
	resize: () => void;
	dispose: () => void;
};

/**
 * Owns the explicit shell surface used by the native compositor.
 *
 * The native path uses a BaseWindow so there is no implicit BrowserWindow
 * renderer competing with this explicit shell surface. The main process can
 * then move the shell above/below the live browser page without a hidden blank
 * renderer covering it.
 */
export function createWindowComposition(options: {
	mainWindow: MainWindowHost;
	WebContentsView: WebContentsViewConstructor;
	preload: string;
}): WindowComposition {
	const shellView = new options.WebContentsView({
		webPreferences: {
			preload: options.preload,
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			transparent: true,
		},
	});
	shellView.setBackgroundColor("#00000000");
	options.mainWindow.contentView.addChildView(shellView, 0);

	let overlayOpen = false;
	const resize = (): void => {
		if (options.mainWindow.isDestroyed?.()) return;
		const bounds = options.mainWindow.contentView.getBounds();
		shellView.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
		shellView.setVisible(true);
	};
	options.mainWindow.contentView.on("bounds-changed", resize);

	const setOverlayOpen = (open: boolean): void => {
		if (overlayOpen === open) return;
		overlayOpen = open;
		if (open) {
			// Re-adding an existing child raises it above all page/DevTools views.
			options.mainWindow.contentView.addChildView(shellView);
		} else {
			// Index zero leaves every live native surface above the transparent shell.
			options.mainWindow.contentView.addChildView(shellView, 0);
		}
	};

	resize();

	return {
		shellView,
		shellWebContents: shellView.webContents,
		setOverlayOpen,
		resize,
		dispose: () => {
			options.mainWindow.contentView.removeListener("bounds-changed", resize);
			try {
				options.mainWindow.contentView.removeChildView(shellView);
			} catch {
				// The BaseWindow may already have destroyed its content hierarchy.
			}
			try {
				shellView.webContents.close();
			} catch {
				// Explicit shell WebContents ownership is idempotent during teardown.
			}
		},
	};
}
