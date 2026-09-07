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
): (source: SaveLinkSource, url: string) => Promise<void> {
	return async (source, url) => {
		const result = await showSaveDialog({ defaultPath: suggestedFilename(url) });
		if (result.canceled || !result.filePath) return;

		let timeout: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timeout) clearTimeout(timeout);
			source.session.off("will-download", onDownload);
		};
		const onDownload: DownloadListener = (_event, item, downloadSource) => {
			if (downloadSource.id !== source.id || !item.getURLChain().includes(url)) return;
			cleanup();
			item.setSavePath(result.filePath!);
		};
		source.session.on("will-download", onDownload);
		timeout = setTimeout(cleanup, 30_000);
		timeout.unref?.();
		try {
			source.downloadURL(url);
		} catch (error) {
			cleanup();
			throw error;
		}
	};
}
