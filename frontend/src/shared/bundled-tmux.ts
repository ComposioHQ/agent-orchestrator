function joinPath(...segments: string[]): string {
	return segments.map((segment) => segment.replace(/[/\\]+$/, "")).join("/");
}

// Packaged Unix builds always point the daemon at AO's own tmux. Returning a
// concrete path (rather than prepending PATH) makes a broken/missing bundle fail
// closed instead of silently falling back to an arbitrary machine installation.
export function bundledTmuxBinaryPath(
	isPackaged: boolean,
	resourcesPath: string,
	platform: NodeJS.Platform,
): string | null {
	if (!isPackaged || (platform !== "darwin" && platform !== "linux")) return null;
	return joinPath(resourcesPath, "tmux", "bin", "tmux");
}
