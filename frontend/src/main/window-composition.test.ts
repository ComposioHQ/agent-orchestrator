import { describe, expect, it, vi } from "vitest";
import { createWindowComposition } from "./window-composition";

function setup() {
	let bounds = { x: 0, y: 0, width: 900, height: 640 };
	const addChildView = vi.fn();
	const removeChildView = vi.fn();
	const close = vi.fn();
	const view = {
		webContents: { close },
		setBackgroundColor: vi.fn(),
		setBounds: vi.fn(),
		setVisible: vi.fn(),
	};
	const mainWindow = {
		contentView: { addChildView, removeChildView },
		getContentBounds: () => bounds,
		isDestroyed: () => false,
		on: vi.fn(),
	};
	function FakeWebContentsView() {
		return view;
	}
	const composition = createWindowComposition({
		mainWindow: mainWindow as never,
		WebContentsView: FakeWebContentsView as never,
		preload: "/preload.js",
	});
	return { addChildView, bounds: () => bounds, close, composition, mainWindow, removeChildView, view };
}

describe("createWindowComposition", () => {
	it("creates a transparent shell at window bounds and reorders it for overlays", () => {
		const { addChildView, composition, view } = setup();

		expect(view.setBackgroundColor).toHaveBeenCalledWith("#00000000");
		expect(addChildView).toHaveBeenNthCalledWith(1, view, 0);
		expect(view.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 900, height: 640 });

		composition.setOverlayOpen(true);
		expect(addChildView).toHaveBeenLastCalledWith(view);
		composition.setOverlayOpen(false);
		expect(addChildView).toHaveBeenLastCalledWith(view, 0);
	});

	it("resizes and disposes the explicit shell without recreating it", () => {
		const { bounds, close, composition, removeChildView, view } = setup();

		(view.setBounds as ReturnType<typeof vi.fn>).mockClear();
		composition.resize();
		expect(view.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 900, height: 640 });
		expect(bounds()).toEqual({ x: 0, y: 0, width: 900, height: 640 });

		composition.dispose();
		expect(removeChildView).toHaveBeenCalledWith(view);
		expect(close).toHaveBeenCalledOnce();
	});
});
