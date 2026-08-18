import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import type {
  BrowserImportEngineOptions,
  BrowserImportResult,
  BrowserImportScan,
  createBrowserImportEngine,
} from "./browser-import-engine";
import {
  browserBookmarkSummary,
  browserBookmarkView,
  type BrowserBookmarkStorage,
  type BrowserBookmarkView,
} from "./browser-bookmark-store";
import type {
  BrowserImportSummary,
  BrowserProfilePersistence,
  BrowserProfileStorage,
} from "./browser-profile-storage";

export const BROWSER_IMPORT_DETECT_CHANNEL = "browserImport:detect";
export const BROWSER_IMPORT_IMPORT_CHANNEL = "browserImport:import";
export const BROWSER_IMPORT_STATUS_CHANNEL = "browserImport:getStatus";
export const BROWSER_IMPORT_USE_EPHEMERAL_CHANNEL =
  "browserImport:useEphemeral";
export const BROWSER_BOOKMARKS_GET_CHANNEL = "browserBookmarks:get";

export type BrowserImportStatus = {
  persistence: BrowserProfilePersistence;
  destinationActive: boolean;
  summary: BrowserImportSummary | null;
};

export type BrowserImportActivationRequest = {
  sourceId: string;
  activate: true;
};

export type BrowserImportResponse = BrowserImportResult & {
  persistence: BrowserProfilePersistence;
};

type BrowserImportEngine = Pick<
  ReturnType<typeof createBrowserImportEngine>,
  "detect" | "importSource"
>;

export type BrowserImportController = {
  detect: () => Promise<BrowserImportScan>;
  importSource: (input: unknown) => Promise<BrowserImportResponse>;
  getStatus: () => Promise<BrowserImportStatus>;
  useEphemeral: () => Promise<BrowserImportStatus>;
  getBookmarks: () => Promise<BrowserBookmarkView | null>;
};

function parseActivationRequest(
  input: unknown,
): BrowserImportActivationRequest {
  if (typeof input !== "object" || input === null)
    throw new Error("Invalid browser import request");
  const request = input as Partial<BrowserImportActivationRequest>;
  if (
    typeof request.sourceId !== "string" ||
    request.sourceId.length === 0 ||
    request.sourceId.length > 200
  ) {
    throw new Error("Invalid browser import source");
  }
  if (request.activate !== true)
    throw new Error("Browser import activation must be true");
  return { sourceId: request.sourceId, activate: true };
}

export function createBrowserImportController({
  engine,
  profileStorage,
  bookmarkStorage,
  now = () => new Date(),
}: {
  engine: BrowserImportEngine;
  profileStorage: BrowserProfileStorage;
  bookmarkStorage: BrowserBookmarkStorage;
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
    summary: browserBookmarkSummary(await bookmarkStorage.read()),
  });

  return {
    detect: () => runOperation(() => engine.detect()),
    importSource: (input) =>
      runOperation(async () => {
        const request = parseActivationRequest(input);
        const result = await engine.importSource(request.sourceId);
        const document = {
          version: 1 as const,
          source: {
            browser: result.sourceBrowser,
            profile: result.sourceProfile,
            fingerprint: result.sourceFingerprint,
          },
          importedAt: now().toISOString(),
          importedBookmarks: result.importedBookmarks,
          skippedBookmarks: result.skippedBookmarks,
          roots: result.bookmarks,
        };
        const committed = await bookmarkStorage.write(document);
        try {
          await profileStorage.selectPersistence("persistent");
        } catch (error) {
          if (committed.created)
            await bookmarkStorage.removeIfMatches(document).catch(() => undefined);
          throw error;
        }
        const { bookmarks: _bookmarks, sourceFingerprint: _sourceFingerprint, ...response } = result;
        return { ...response, persistence: profileStorage.getPersistence() };
      }),
    getStatus: () => runOperation(getStatus),
    useEphemeral: () =>
      runOperation(async () => {
        await profileStorage.selectPersistence("ephemeral");
        return getStatus();
      }),
    getBookmarks: () =>
      runOperation(async () => {
        const document = await bookmarkStorage.read();
        return document ? browserBookmarkView(document) : null;
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
  const requireTrustedSender = (
    event: IpcMainInvokeEvent,
  ): BrowserImportController => {
    const trustedSender = getTrustedSender();
    if (!trustedSender || event.sender !== trustedSender) {
      throw new Error("Browser import is only available to the AO shell");
    }
    return getController();
  };
  ipcMain.handle(BROWSER_IMPORT_DETECT_CHANNEL, (event) =>
    requireTrustedSender(event).detect(),
  );
  ipcMain.handle(BROWSER_IMPORT_IMPORT_CHANNEL, (event, input: unknown) => {
    const controller = requireTrustedSender(event);
    parseActivationRequest(input);
    return controller.importSource(input);
  });
  ipcMain.handle(BROWSER_IMPORT_STATUS_CHANNEL, (event) =>
    requireTrustedSender(event).getStatus(),
  );
  ipcMain.handle(BROWSER_IMPORT_USE_EPHEMERAL_CHANNEL, (event) =>
    requireTrustedSender(event).useEphemeral(),
  );
  ipcMain.handle(BROWSER_BOOKMARKS_GET_CHANNEL, (event) =>
    requireTrustedSender(event).getBookmarks(),
  );
}

// Keep this type import in the module so changes to the main-engine constructor
// remain visible to the boundary without importing Electron in engine tests.
export type BrowserImportEngineConfig = BrowserImportEngineOptions;
