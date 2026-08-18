import { Bookmark, Folder, LoaderCircle, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	BrowserBookmarkNode,
	BrowserBookmarkRoots,
	BrowserBookmarkView,
} from "../../main/browser-bookmark-store";
import { aoBridge } from "../lib/bridge";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

export type BrowserBookmarksPopoverProps = {
	onOpenBookmark: (url: string) => Promise<void> | void;
};

export function BrowserBookmarksPopover({ onOpenBookmark }: BrowserBookmarksPopoverProps) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [bookmarks, setBookmarks] = useState<BrowserBookmarkView | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState(false);

	useEffect(() => {
		if (!open) return;
		let mounted = true;
		setLoading(true);
		setError(false);
		void aoBridge.browserBookmarks
			.get()
			.then((next) => {
				if (!mounted) return;
				setBookmarks(next);
			})
			.catch(() => {
				if (mounted) setError(true);
			})
			.finally(() => {
				if (mounted) setLoading(false);
			});
		return () => {
			mounted = false;
		};
	}, [open]);

	const openBookmark = async (url: string) => {
		try {
			await onOpenBookmark(url);
			setOpen(false);
		} catch {
			setError(true);
		}
	};

	return (
		<div className="relative flex shrink-0 items-center self-stretch border-l border-border">
			<Button
				aria-expanded={open}
				aria-haspopup="menu"
				aria-label={t("browser.bookmarks")}
				className={cn(open && "bg-muted")}
				onClick={() => setOpen((current) => !current)}
				size="icon-sm"
				title={t("browser.bookmarks")}
				type="button"
				variant="ghost"
			>
				<Bookmark aria-hidden="true" className="size-icon-base" />
			</Button>
			<div
				aria-label={t("browser.bookmarks")}
				className={cn(
					"absolute right-0 top-full z-chrome mt-1 w-72 max-w-[min(18rem,calc(100vw-2rem))] overflow-hidden rounded-md border border-border bg-card shadow-(--shadow-popover)",
					"data-[state=closed]:pointer-events-none data-[state=closed]:invisible data-[state=closed]:opacity-0",
					"data-[state=open]:visible data-[state=open]:opacity-100",
				)}
				data-browser-native-overlay="true"
				data-state={open ? "open" : "closed"}
				data-testid="browser-bookmarks-popover"
				role="menu"
			>
				<div className="border-b border-border px-3 py-2 text-xs font-medium text-foreground">
					{t("browser.bookmarks")}
				</div>
				{loading ? (
					<div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground" role="status">
						<LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
						{t("browser.bookmarksLoading")}
					</div>
				) : error ? (
					<div className="flex items-center gap-2 px-3 py-3 text-xs text-error" role="alert">
						<TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
						{t("browser.bookmarksFailed")}
					</div>
				) : bookmarks ? (
					<div className="max-h-80 overflow-y-auto p-1">
						<BookmarkRoots roots={bookmarks.roots} onOpenBookmark={openBookmark} />
					</div>
				) : (
					<p className="px-3 py-3 text-xs text-muted-foreground">{t("browser.bookmarksEmpty")}</p>
				)}
			</div>
		</div>
	);
}

function BookmarkRoots({ roots, onOpenBookmark }: { roots: BrowserBookmarkRoots; onOpenBookmark: (url: string) => Promise<void> }) {
	return (
		<div className="flex flex-col gap-1">
			{([roots.bookmark_bar, roots.other, roots.synced] as const).map((root) => (
				<BookmarkFolder key={root.id} node={root} depth={0} onOpenBookmark={onOpenBookmark} />
			))}
		</div>
	);
}

function BookmarkFolder({
	node,
	depth,
	onOpenBookmark,
}: {
	node: Extract<BrowserBookmarkNode, { type: "folder" }>;
	depth: number;
	onOpenBookmark: (url: string) => Promise<void>;
}) {
	return (
		<div>
			<div className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-muted-foreground" style={{ paddingLeft: `${8 + depth * 12}px` }}>
				<Folder aria-hidden="true" className="size-3.5 shrink-0" />
				<span className="min-w-0 truncate">{node.name}</span>
			</div>
			<div>
				{node.children.map((child) =>
					child.type === "folder" ? (
						<BookmarkFolder key={child.id} node={child} depth={depth + 1} onOpenBookmark={onOpenBookmark} />
					) : (
						<button
							className="flex w-full min-w-0 items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-foreground hover:bg-muted"
							key={child.id}
							onClick={() => void onOpenBookmark(child.url)}
							style={{ paddingLeft: `${20 + depth * 12}px` }}
							type="button"
						>
							<Bookmark aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
							<span className="min-w-0 truncate">{child.name}</span>
						</button>
					),
				)}
			</div>
		</div>
	);
}
