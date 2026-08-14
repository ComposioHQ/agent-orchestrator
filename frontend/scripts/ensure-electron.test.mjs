import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  ensureElectronInstalled,
  inspectElectronInstall,
} from "./ensure-electron.mjs";

function fakeElectronPackage() {
  const root = mkdtempSync(join(tmpdir(), "ao-electron-test-"));
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "electron", version: "33.4.11" }),
  );
  writeFileSync(join(root, "dist", "version"), "33.4.11");
  writeFileSync(join(root, "install.js"), "// fake installer\n");
  return root;
}

describe("ensureElectronInstalled", () => {
  it("accepts a complete Electron install", () => {
    const root = fakeElectronPackage();
    writeFileSync(join(root, "path.txt"), "electron.exe");
    writeFileSync(join(root, "dist", "electron.exe"), "binary");

    const env = { npm_config_platform: "win32" };
    expect(inspectElectronInstall(root, env)).toMatchObject({ ready: true });
    expect(ensureElectronInstalled({ electronRoot: root, env })).toBe(
      join(root, "dist", "electron.exe"),
    );
  });

  it("repairs the missing path marker and binary before Forge starts", () => {
    const root = fakeElectronPackage();
    const log = { warn: vi.fn(), log: vi.fn() };
    const run = vi.fn(() => {
      writeFileSync(join(root, "path.txt"), "electron.exe");
      writeFileSync(join(root, "dist", "electron.exe"), "binary");
      return { status: 0 };
    });

    expect(
      ensureElectronInstalled({
        electronRoot: root,
        env: { npm_config_platform: "win32" },
        run,
        log,
      }),
    ).toBe(join(root, "dist", "electron.exe"));
    expect(run).toHaveBeenCalledWith(join(root, "install.js"));
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("repairing it now"),
    );
  });

  it("repairs a node_modules tree copied from a different platform", () => {
    const root = fakeElectronPackage();
    writeFileSync(join(root, "path.txt"), "electron.exe");
    writeFileSync(join(root, "dist", "electron.exe"), "windows binary");
    const run = vi.fn(() => {
      mkdirSync(join(root, "dist", "Electron.app", "Contents", "MacOS"), {
        recursive: true,
      });
      writeFileSync(
        join(root, "path.txt"),
        "Electron.app/Contents/MacOS/Electron",
      );
      writeFileSync(
        join(root, "dist", "Electron.app", "Contents", "MacOS", "Electron"),
        "mac binary",
      );
      return { status: 0 };
    });

    ensureElectronInstalled({
      electronRoot: root,
      env: { npm_config_platform: "darwin" },
      run,
      log: { warn: vi.fn(), log: vi.fn() },
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it("reports an actionable error when the repair download fails", () => {
    const root = fakeElectronPackage();
    expect(() =>
      ensureElectronInstalled({
        electronRoot: root,
        run: () => ({ status: 1 }),
        log: { warn: vi.fn(), log: vi.fn() },
      }),
    ).toThrow(/proxy\/antivirus settings/);
  });

  it("does not override an explicit download skip", () => {
    const root = fakeElectronPackage();
    expect(() =>
      ensureElectronInstalled({
        electronRoot: root,
        env: { ELECTRON_SKIP_BINARY_DOWNLOAD: "1" },
      }),
    ).toThrow(/unset ELECTRON_SKIP_BINARY_DOWNLOAD/);
  });
});
