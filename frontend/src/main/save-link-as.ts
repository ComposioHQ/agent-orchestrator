type SaveDialogResult = { canceled: boolean; filePath?: string };

type DownloadItemLike = {
	getURLChain: () => string[];
	setSavePath: (path: string) => void;
};

type DownloadListener = (event: unknown, item: DownloadItemLike, source: { id: number }) => void;

export type SaveLinkSource = {
	id: number;
	session: {
		on: (event: "will-download", listener: DownloadListener) => unknown;
		off: (event: "will-download", listener: DownloadListener) => unknown;
	};
	downloadURL: (url: string) => void;
	isDestroyed?: () => boolean;
	on?: (event: "destroyed", listener: () => void) => unknown;
	off?: (event: "destroyed", listener: () => void) => unknown;
};

function suggestedFilename(value: string): string {
	try {
		const pathname = new URL(value).pathname;
		const segment = pathname.split("/").filter(Boolean).at(-1);
		if (!segment) return "download";
		return decodeURIComponent(segment).replaceAll(/[\\/:*?"<>|]/g, "-") || "download";
	} catch {
		return "download";
	}
}

export function createSaveLinkAs(
	showSaveDialog: (options: { defaultPath: string }) => Promise<SaveDialogResult>,
): (source: SaveLinkSource, url: string, isValid?: () => boolean) => Promise<void> {
	return async (source, url, isValid) => {
		const result = await showSaveDialog({ defaultPath: suggestedFilename(url) });
		if (result.canceled || !result.filePath) return;
		if (source.isDestroyed?.() || (isValid && !isValid())) return;

		let timeout: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timeout) clearTimeout(timeout);
			source.session.off("will-download", onDownload);
			source.off?.("destroyed", cleanup);
		};
		const onDownload: DownloadListener = (_event, item, downloadSource) => {
			if (downloadSource.id !== source.id || !item.getURLChain().includes(url)) return;
			cleanup();
			item.setSavePath(result.filePath!);
		};
		source.session.on("will-download", onDownload);
		source.on?.("destroyed", cleanup);
		timeout = setTimeout(cleanup, 30_000);
		timeout.unref?.();
		if (source.isDestroyed?.() || (isValid && !isValid())) {
			cleanup();
			return;
		}
		try {
			source.downloadURL(url);
		} catch (error) {
			cleanup();
			throw error;
		}
	};
}
