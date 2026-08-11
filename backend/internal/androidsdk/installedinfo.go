package androidsdk

// InstalledSystemImageSHA1 returns the checksum of the system image recorded
// as installed at toolsDir, if any. This is the stable input Track A's
// snapshot-invalidation logic (androidemulator.EnsureSnapshotValid) keys on:
// when it changes, a saved quick-boot snapshot no longer matches what's on
// disk and must be discarded.
func InstalledSystemImageSHA1(toolsDir string) (string, bool) {
	m, ok := readInstalledManifest(toolsDir)
	if !ok || m.SystemImageSHA1 == "" {
		return "", false
	}
	return m.SystemImageSHA1, true
}
