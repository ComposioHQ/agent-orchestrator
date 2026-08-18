import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import type {
	BrowserImportEngineOptions,
	BrowserImportResult,
	BrowserImportScan,
	createBrowserImportEngine,
} from "./browser-import-engine";
import type { BrowserImportSummary, BrowserProfilePersistence, BrowserProfileStorage } from "./browser-profile-storage";

export const BROWSER_IMPORT_DETECT_CHANNEL = "browserImport:detect";
export const BROWSER_IMPORT_IMPORT_CHANNEL = "browserImport:import";
export const BROWSER_IMPORT_STATUS_CHANNEL = "browserImport:getStatus";
export const BROWSER_IMPORT_USE_EPHEMERAL_CHANNEL = "browserImport:useEphemeral";

export type BrowserImportStatus = {
	persistence: BrowserProfilePersistence;
	destinationActive: boolean;
	summary: BrowserImportSummary | null;
};

export type BrowserImportActivationRequest = {
	sourceId: string;
	activate: boolean;
};

export type BrowserImportResponse = BrowserImportResult & { persistence: BrowserProfilePersistence };

type BrowserImportEngine = Pick<ReturnType<typeof createBrowserImportEngine>, "detect" | "importSource">;

export type BrowserImportController = {
	detect: () => Promise<BrowserImportScan>;
	importSource: (input: unknown) => Promise<BrowserImportResponse>;
	getStatus: () => Promise<BrowserImportStatus>;
	useEphemeral: () => Promise<BrowserImportStatus>;
};

function parseActivationRequest(input: unknown): BrowserImportActivationRequest {
	if (typeof input !== "object" || input === null) throw new Error("Invalid browser import request");
	const request = input as Partial<BrowserImportActivationRequest>;
	if (typeof request.sourceId !== "string" || request.sourceId.length === 0 || request.sourceId.length > 200) {
		throw new Error("Invalid browser import source");
	}
	if (typeof request.activate !== "boolean") throw new Error("Browser import activation must be explicit");
	return { sourceId: request.sourceId, activate: request.activate };
}

export function createBrowserImportController({
	engine,
	profileStorage,
	now = () => new Date(),
}: {
	engine: BrowserImportEngine;
	profileStorage: BrowserProfileStorage;
	now?: () => Date;
}): BrowserImportController {
	let operationQueue: Promise<unknown> = Promise.resolve();
	const runOperation = <T>(operation: () => Promise<T>): Promise<T> => {
		const queued = operationQueue.then(operation, operation);
		operationQueue = queued.then(
			() => undefined,
			() => undefined,
		);
		return queued;
	};

	const getStatus = async (): Promise<BrowserImportStatus> => ({
		persistence: profileStorage.getPersistence(),
		destinationActive: profileStorage.isPersistentDestinationActive(),
		summary: await profileStorage.readImportSummary(),
	});

	return {
		detect: () => runOperation(() => engine.detect()),
		importSource: (input) =>
			runOperation(async () => {
				const request = parseActivationRequest(input);
				const result = await engine.importSource(request.sourceId);
				let activated = false;
				try {
					if (request.activate) {
						await profileStorage.selectPersistence("persistent");
						activated = true;
					}
					await profileStorage.writeImportSummary({
						sourceBrowser: result.sourceBrowser,
						sourceProfile: result.sourceProfile,
						importedBookmarks: result.importedBookmarks,
						skippedBookmarks: result.skippedBookmarks,
						importedAt: now().toISOString(),
					});
				} catch (error) {
					if (activated) await profileStorage.selectPersistence("ephemeral").catch(() => undefined);
					throw error;
				}
				return { ...result, persistence: profileStorage.getPersistence() };
			}),
		getStatus: () => runOperation(getStatus),
		useEphemeral: () => runOperation(async () => {
			await profileStorage.selectPersistence("ephemeral");
			return getStatus();
		}),
	};
}

export function registerBrowserImportIPC({
	ipcMain,
	getTrustedSender,
	getController,
}: {
	ipcMain: Pick<IpcMain, "handle">;
	getTrustedSender: () => WebContents | null;
	getController: () => BrowserImportController;
}): void {
	const requireTrustedSender = (event: IpcMainInvokeEvent): BrowserImportController => {
		if (!getTrustedSender() || event.sender !== getTrustedSender()) {
			throw new Error("Browser import is only available to the AO shell");
		}
		return getController();
	};
	ipcMain.handle(BROWSER_IMPORT_DETECT_CHANNEL, (event) => requireTrustedSender(event).detect());
	ipcMain.handle(BROWSER_IMPORT_IMPORT_CHANNEL, (event, input: unknown) =>
		requireTrustedSender(event).importSource(input),
	);
	ipcMain.handle(BROWSER_IMPORT_STATUS_CHANNEL, (event) => requireTrustedSender(event).getStatus());
	ipcMain.handle(BROWSER_IMPORT_USE_EPHEMERAL_CHANNEL, (event) => requireTrustedSender(event).useEphemeral());
}

// Keep this type import in the module so changes to the main-engine constructor
// remain visible to the boundary without importing Electron in engine tests.
export type BrowserImportEngineConfig = BrowserImportEngineOptions;
