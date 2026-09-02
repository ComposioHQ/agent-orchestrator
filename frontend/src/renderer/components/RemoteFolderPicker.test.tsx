import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { remoteRequest } from "../../main/remote-request";
import { aoBridge } from "../lib/bridge";
import { fakeDaemon, type Behaviour } from "../test/fake-daemon";
import { RemoteFolderPicker } from "./RemoteFolderPicker";

const listing = (path: string, parent: string, entries: Array<{ name: string; path: string; gitRepo: boolean }>) => ({
	status: 200,
	body: { path, parent, entries },
});

beforeEach(() => {
	vi.restoreAllMocks();
});

function renderPicker(props: Partial<Parameters<typeof RemoteFolderPicker>[0]> = {}) {
	render(
		<RemoteFolderPicker
			hostUrl="http://192.0.2.1:3011"
			hostLabel="workbox"
			open
			onOpenChange={vi.fn()}
			onSelect={vi.fn()}
			{...props}
		/>,
	);
}

describe("RemoteFolderPicker", () => {
	// Stepping in replaces every row, so whichever row had focus stops existing
	// and focus falls back to the dialog — a keyboard user loses their place on
	// every hop.
	it("moves focus into the folder it just stepped into", async () => {
		vi.spyOn(aoBridge.remotes, "request")
			.mockResolvedValueOnce(listing("/home/dev", "/home", [{ name: "repo", path: "/home/dev/repo", gitRepo: false }]))
			.mockResolvedValueOnce(listing("/home/dev/repo", "/home/dev", [{ name: "src", path: "/home/dev/repo/src", gitRepo: false }]));
		renderPicker();

		await userEvent.click(await screen.findByRole("button", { name: /^repo/ }));

		// "Up" is the first row of the new listing.
		expect(await screen.findByRole("button", { name: /^up$/i })).toHaveFocus();
	});

	it("says it is loading while the host answers", async () => {
		type Answer = Awaited<ReturnType<typeof aoBridge.remotes.request>>;
		let release: (value: Answer) => void = () => {};
		vi.spyOn(aoBridge.remotes, "request").mockReturnValue(
			new Promise<Answer>((resolve) => {
				release = resolve;
			}),
		);
		renderPicker();

		expect(await screen.findByRole("status")).toHaveTextContent(/loading folders/i);
		release(listing("/home/dev", "/home", []) as Answer);
		await screen.findByText(/no subfolders/i);
		// Stays mounted and empties: role="status" is announced far more reliably
		// on a content change than on insertion.
		expect(screen.getByRole("status")).toBeEmptyDOMElement();
	});

	it.each<Behaviour>(["html-catchall", "wrong-shape"])(
		"reports a version gap without throwing when the daemon returns %s",
		async (behaviour) => {
			vi.spyOn(aoBridge.remotes, "request").mockImplementation((_url, init) =>
				remoteRequest(
					{ label: "workbox", url: "http://192.0.2.1:3011", password: "pw" },
					init,
					fakeDaemon(behaviour),
				),
			);

			expect(() => renderPicker()).not.toThrow();
			expect(await screen.findByRole("alert")).toHaveTextContent(/older build/i);
		},
	);

	it("opens at the host's home and marks git repos", async () => {
		vi.spyOn(aoBridge.remotes, "request").mockResolvedValue(
			listing("/home/dev", "/home", [
				{ name: "repo", path: "/home/dev/repo", gitRepo: true },
				{ name: "notes", path: "/home/dev/notes", gitRepo: false },
			]),
		);
		renderPicker();

		expect(await screen.findByRole("button", { name: /^repo/ })).toBeInTheDocument();
		expect(aoBridge.remotes.request).toHaveBeenCalledWith("http://192.0.2.1:3011", {
			method: "GET",
			path: "/api/v1/fs/dirs",
		});
		expect(screen.getByRole("button", { name: /^repo/ })).toHaveTextContent(/git/i);
		expect(screen.getByRole("button", { name: /^notes/ })).not.toHaveTextContent(/git/i);
	});

	it("descends into a directory and can go up", async () => {
		const request = vi
			.spyOn(aoBridge.remotes, "request")
			.mockResolvedValueOnce(listing("/home/dev", "/home", [{ name: "src", path: "/home/dev/src", gitRepo: false }]))
			.mockResolvedValueOnce(
				listing("/home/dev/src", "/home/dev", [{ name: "app", path: "/home/dev/src/app", gitRepo: true }]),
			)
			.mockResolvedValueOnce(listing("/home/dev", "/home", [{ name: "src", path: "/home/dev/src", gitRepo: false }]));

		renderPicker();
		await userEvent.click(await screen.findByRole("button", { name: /^src/ }));

		expect(await screen.findByRole("button", { name: /^app/ })).toBeInTheDocument();
		expect(request).toHaveBeenLastCalledWith("http://192.0.2.1:3011", {
			method: "GET",
			path: `/api/v1/fs/dirs?path=${encodeURIComponent("/home/dev/src")}`,
		});

		await userEvent.click(screen.getByRole("button", { name: /up/i }));
		expect(await screen.findByRole("button", { name: /^src/ })).toBeInTheDocument();
		expect(request).toHaveBeenLastCalledWith("http://192.0.2.1:3011", {
			method: "GET",
			path: `/api/v1/fs/dirs?path=${encodeURIComponent("/home/dev")}`,
		});
	});

	it("selects the current directory", async () => {
		vi.spyOn(aoBridge.remotes, "request").mockResolvedValue(listing("/home/dev/repo", "/home/dev", []));
		const onSelect = vi.fn();
		renderPicker({ onSelect });

		await userEvent.click(await screen.findByRole("button", { name: /choose this folder/i }));
		expect(onSelect).toHaveBeenCalledWith("/home/dev/repo");
	});

	// GET /api/v1/fs/dirs is new, so a saved host on an older build is the normal
	// case, not an edge one. Every unreadable 200 below used to reach
	// `listing.entries.map` as undefined and take the whole renderer down.
	describe("a 200 that is not a listing", () => {
		const cases: Array<[string, unknown]> = [
			// What an older daemon's web-UI catch-all actually serves for a route it
			// does not know: 200, and a page.
			["html from an older daemon's catch-all", "<!doctype html><html><body>AO</body></html>"],
			["json without an entries key", { path: "/home/dev", parent: "/home" }],
			["entries that is not an array", { path: "/home/dev", parent: "/home", entries: { "0": "repo" } }],
			["entries holding rows that are not entries", { path: "/home/dev", parent: "/home", entries: [null] }],
		];

		for (const [name, body] of cases) {
			it(`reports a version gap for ${name}`, async () => {
				vi.spyOn(aoBridge.remotes, "request").mockResolvedValue({ status: 200, body });
				renderPicker();

				expect(await screen.findByRole("alert")).toHaveTextContent(/older build/i);
				// The honest failure, not a folder that merely looks empty.
				expect(screen.queryByText(/no subfolders/i)).not.toBeInTheDocument();
			});
		}
	});

	it("reports a failure when the host has no folder-browsing route at all", async () => {
		vi.spyOn(aoBridge.remotes, "request").mockResolvedValue({ status: 404, body: null });
		renderPicker();

		expect(await screen.findByRole("alert")).toHaveTextContent(/could not list folders/i);
	});

	it("renders the daemon's error text when browsing fails", async () => {
		// The locked envelope is flat {code, error, message} (schema.ts APIError),
		// not a nested {error:{message}}.
		vi.spyOn(aoBridge.remotes, "request").mockResolvedValue({
			status: 403,
			body: {
				code: "FS_FORBIDDEN",
				error: "the daemon may not read that directory",
				message: "the daemon may not read that directory",
			},
		});
		renderPicker();

		expect(await screen.findByRole("alert")).toHaveTextContent(/may not read/i);
	});
});
