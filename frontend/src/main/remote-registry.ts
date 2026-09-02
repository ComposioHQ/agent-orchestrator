import type { ActiveProxy } from "./remote-proxy";
import type { RemoteEntry } from "./remotes-store";

/** What the renderer may know about a connected host. Password stays here. */
export type ConnectedHostView = {
	label: string;
	url: string;
	base: string;
};

type StartProxy = (entry: RemoteEntry) => Promise<ActiveProxy>;

// N hosts live at once, one proxy each, keyed by url: the app does not view
// one host, it talks to several.
export class RemoteRegistry {
	private readonly live = new Map<string, { view: ConnectedHostView; proxy: ActiveProxy }>();

	constructor(private readonly start: StartProxy) {}

	async connect(entry: RemoteEntry): Promise<ConnectedHostView> {
		const existing = this.live.get(entry.url);
		// Reuse rather than restart: a second connect would strand the first
		// proxy's port with the renderer still holding streams against it.
		if (existing) return existing.view;

		const proxy = await this.start(entry);
		const view = { label: entry.label, url: entry.url, base: proxy.base };
		this.live.set(entry.url, { view, proxy });
		return view;
	}

	async disconnect(url: string): Promise<void> {
		const entry = this.live.get(url);
		if (!entry) return;
		this.live.delete(url);
		await entry.proxy.close();
	}

	views(): ConnectedHostView[] {
		return [...this.live.values()].map(({ view }) => view);
	}

	async closeAll(): Promise<void> {
		const entries = [...this.live.values()];
		this.live.clear();
		await Promise.all(entries.map(({ proxy }) => proxy.close()));
	}
}
