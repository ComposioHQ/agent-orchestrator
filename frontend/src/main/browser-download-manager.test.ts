import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserDownloadManager } from "./browser-download-manager";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
	const root = mkdtempSync(path.join(os.tmpdir(), "ao-browser-downloads-"));
	temporaryDirectories.push(root);
	const downloadsDirectory = path.join(root, "Downloads");
	const historyPath = path.join(root, "data", "browser-downloads.json");
	const notify = vi.fn();
	const openPath = vi.fn(async () => "");
	const showItemInFolder = vi.fn();
	const manager = createBrowserDownloadManager({
		downloadsDirectory,
		historyPath,
		shell: { openPath, showItemInFolder },
		notify,
		now: () => 42,
		createId: () => "download-1",
	});
	const session = new EventEmitter();
	const sessionOn = vi.spyOn(session, "on");
	const removeListener = vi.spyOn(session, "removeListener");
	manager.attach(session as never);
	return {
		downloadsDirectory,
		historyPath,
		manager,
		notify,
		openPath,
		removeListener,
		session,
		sessionOn,
		showItemInFolder,
		start: (item: FakeDownloadItem) => session.emit("will-download", {}, item),
	};
}

class FakeDownloadItem extends EventEmitter {
	receivedBytes = 0;
	totalBytes = 100;
	paused = false;
	resumable = true;
	setSavePath = vi.fn();
	pause = vi.fn(() => { this.paused = true; });
	resume = vi.fn(() => { this.paused = false; });
	cancel = vi.fn();
	getFilename = () => "report.txt";
	getReceivedBytes = () => this.receivedBytes;
	getTotalBytes = () => this.totalBytes;
	isPaused = () => this.paused;
	canResume = () => this.resumable;
}

describe("browser download manager", () => {
	it("tracks progress, supports controls, and reveals a completed system download", async () => {
		const test = setup();
		mkdirSync(test.downloadsDirectory, { recursive: true });
		writeFileSync(path.join(test.downloadsDirectory, "report.txt"), "existing");
		const item = new FakeDownloadItem();

		test.start(item);
		const savePath = path.join(test.downloadsDirectory, "report (1).txt");
		expect(item.setSavePath).toHaveBeenCalledWith(savePath);
		expect(test.manager.list().downloads[0]).toMatchObject({ id: "download-1", fileName: "report (1).txt", status: "progressing" });

		item.receivedBytes = 25;
		item.emit("updated", {}, "progressing");
		expect(test.manager.list().downloads[0]?.receivedBytes).toBe(25);
		await test.manager.action({ id: "download-1", action: "pause" });
		expect(item.pause).toHaveBeenCalledOnce();
		await test.manager.action({ id: "download-1", action: "resume" });
		expect(item.resume).toHaveBeenCalledOnce();

		item.receivedBytes = 100;
		item.emit("done", {}, "completed");
		writeFileSync(savePath, "downloaded");
		await test.manager.action({ id: "download-1", action: "show" });
		expect(test.showItemInFolder).toHaveBeenCalledWith(savePath);
		await test.manager.action({ id: "download-1", action: "open" });
		expect(test.openPath).toHaveBeenCalledWith(savePath);
		expect(JSON.parse(readFileSync(test.historyPath, "utf8"))[0]).toMatchObject({ status: "completed", savePath });

		test.manager.clear();
		expect(test.manager.list().downloads).toEqual([]);
	});

	it("attaches once per Electron session and restores unfinished history as interrupted", () => {
		const test = setup();
		test.manager.attach(test.session as never);
		expect(test.sessionOn).toHaveBeenCalledTimes(1);
		const item = new FakeDownloadItem();
		test.start(item);

		const restored = createBrowserDownloadManager({
			downloadsDirectory: test.downloadsDirectory,
			historyPath: test.historyPath,
			shell: { openPath: vi.fn(async () => ""), showItemInFolder: vi.fn() },
			notify: vi.fn(),
		});
		expect(restored.list().downloads[0]?.status).toBe("interrupted");
		expect(restored.list().downloads[0]?.resumable).toBe(false);
	});

	it("detaches session listeners before a replacement manager attaches", () => {
		const first = setup();
		first.manager.dispose();
		expect(first.removeListener).toHaveBeenCalledOnce();
		first.notify.mockImplementation(() => {
			throw new Error("destroyed shell WebContents");
		});

		const replacementNotify = vi.fn();
		const replacement = createBrowserDownloadManager({
			downloadsDirectory: first.downloadsDirectory,
			historyPath: first.historyPath,
			shell: { openPath: vi.fn(async () => ""), showItemInFolder: vi.fn() },
			notify: replacementNotify,
			createId: () => "download-2",
		});
		replacement.attach(first.session as never);
		first.start(new FakeDownloadItem());

		expect(first.manager.list().downloads).toEqual([]);
		expect(replacement.list().downloads[0]?.id).toBe("download-2");
		expect(replacementNotify).toHaveBeenCalledOnce();
	});

	it("detaches active item listeners when disposed", () => {
		const test = setup();
		const item = new FakeDownloadItem();
		test.start(item);
		expect(item.listenerCount("updated")).toBe(1);
		expect(item.listenerCount("done")).toBe(1);

		test.manager.dispose();

		expect(item.listenerCount("updated")).toBe(0);
		expect(item.listenerCount("done")).toBe(0);
	});

	it("keeps an interrupted item resumable until Electron reports it done", async () => {
		const test = setup();
		const item = new FakeDownloadItem();
		test.start(item);

		item.emit("updated", {}, "interrupted");
		expect(test.manager.list().downloads[0]).toMatchObject({ status: "interrupted", active: true, resumable: true });
		await test.manager.action({ id: "download-1", action: "resume" });
		expect(item.resume).toHaveBeenCalledOnce();

		item.emit("done", {}, "interrupted");
		expect(test.manager.list().downloads[0]).toMatchObject({ status: "interrupted", active: false, resumable: false });
	});
});
