import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const defaultElectronRoot = resolve(
  scriptsDir,
  "..",
  "node_modules",
  "electron",
);

export function inspectElectronInstall(
  electronRoot = defaultElectronRoot,
  env = process.env,
) {
  const packagePath = join(electronRoot, "package.json");
  const installPath = join(electronRoot, "install.js");
  if (!existsSync(packagePath) || !existsSync(installPath)) {
    return {
      ready: false,
      repairable: false,
      reason: "the electron package is missing",
      installPath,
    };
  }

  let packageVersion = "";
  try {
    packageVersion =
      JSON.parse(readFileSync(packagePath, "utf8")).version || "";
  } catch {
    return {
      ready: false,
      repairable: false,
      reason: "Electron's package metadata is unreadable",
      installPath,
    };
  }

  let executableName = "";
  try {
    executableName = readFileSync(join(electronRoot, "path.txt"), "utf8");
  } catch {
    // A missing marker is the common partial-install state on Windows.
  }
  const platform = env.npm_config_platform || process.platform;
  const expectedExecutable = electronExecutableName(platform);
  const distRoot =
    env.ELECTRON_OVERRIDE_DIST_PATH || join(electronRoot, "dist");
  const executablePath = join(distRoot, executableName || "electron");
  let installedVersion = "";
  try {
    installedVersion = readFileSync(join(distRoot, "version"), "utf8").replace(
      /^v/,
      "",
    );
  } catch {
    // Missing version is another partial extraction state.
  }
  if (
    executableName !== expectedExecutable ||
    installedVersion !== packageVersion ||
    !existsSync(executablePath)
  ) {
    const reason =
      executableName && executableName !== expectedExecutable
        ? `Electron was installed for a different platform (${executableName}, expected ${expectedExecutable})`
        : installedVersion !== packageVersion
          ? `Electron's installed version marker is missing or stale (expected ${packageVersion})`
          : executableName
            ? `the Electron binary is missing at ${executablePath}`
            : "Electron's path.txt marker is missing";
    return {
      ready: false,
      repairable: true,
      reason,
      installPath,
      executablePath,
    };
  }
  return { ready: true, repairable: true, installPath, executablePath };
}

export function electronExecutableName(platform) {
  switch (platform) {
    case "darwin":
    case "mas":
      return "Electron.app/Contents/MacOS/Electron";
    case "linux":
    case "freebsd":
    case "openbsd":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      throw new Error(
        `Electron builds are not available on platform: ${platform}`,
      );
  }
}

export function ensureElectronInstalled({
  electronRoot = defaultElectronRoot,
  env = process.env,
  run = (installPath) =>
    spawnSync(process.execPath, [installPath], { env, stdio: "inherit" }),
  log = console,
} = {}) {
  const initial = inspectElectronInstall(electronRoot, env);
  if (initial.ready) return initial.executablePath;
  if (!initial.repairable) {
    throw new Error(
      `${initial.reason}; run \`npm ci\` in frontend and try again`,
    );
  }
  if (env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
    throw new Error(
      `${initial.reason}; unset ELECTRON_SKIP_BINARY_DOWNLOAD and run \`npm run electron:ensure\` again`,
    );
  }

  log.warn(
    `Electron's first-run download is incomplete (${initial.reason}); repairing it now...`,
  );
  const result = run(initial.installPath);
  if (result?.error) {
    throw new Error(
      `could not start Electron's installer: ${result.error.message}`,
    );
  }
  if (result?.status !== 0) {
    throw new Error(
      `Electron's installer exited with status ${result?.status ?? "unknown"}; check proxy/antivirus settings, then run \`npm run electron:ensure\` again`,
    );
  }

  const repaired = inspectElectronInstall(electronRoot, env);
  if (!repaired.ready) {
    throw new Error(`Electron repair completed but ${repaired.reason}`);
  }
  log.log(`Electron is ready at ${repaired.executablePath}`);
  return repaired.executablePath;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    ensureElectronInstalled();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
