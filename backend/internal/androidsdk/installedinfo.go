package androidsdk

import (
	"fmt"
	"path/filepath"
)

// Source values for InstalledSDK.
const (
	SourceAOManaged = "ao_managed"
	SourceExternal  = "external"
)

// InstalledSDK describes the Android SDK currently available to AO at a
// toolsDir, regardless of whether AO downloaded it itself (SourceAOManaged)
// or the user chose to reuse an existing install already on their machine
// (SourceExternal, see Manager.UseExternal).
type InstalledSDK struct {
	Source   string
	Root     string
	APILevel int
	Tag      string
	ABI      string
	// VersionKey is the stable input Track A's snapshot-invalidation logic
	// (androidemulator.EnsureSnapshotValid) keys on: when it changes, a
	// saved quick-boot snapshot no longer matches what's on disk and must
	// be discarded. A real SHA1 for SourceAOManaged; a synthetic
	// mtime+size fingerprint for SourceExternal (nothing was downloaded to
	// checksum).
	VersionKey string
}

// Installed reports the Android SDK currently available to AO at toolsDir.
// AO's own managed install always wins if both an ao_managed manifest and
// an external marker are somehow present -- simple, predictable
// precedence: an explicit "download AO's own copy" supersedes a previously
// adopted external SDK. The external marker is never deleted when this
// happens (harmless, since this precedence rule means it's simply never
// consulted again while the manifest exists).
func Installed(toolsDir string) (InstalledSDK, bool) {
	if m, ok := readInstalledManifest(toolsDir); ok {
		return InstalledSDK{
			Source:     SourceAOManaged,
			Root:       Dir(toolsDir),
			APILevel:   m.APILevel,
			Tag:        m.Tag,
			ABI:        m.ABI,
			VersionKey: m.SystemImageSHA1,
		}, true
	}

	rec, ok := readExternalSDKRecord(toolsDir)
	if !ok {
		return InstalledSDK{}, false
	}
	versionKey, ok := externalVersionKey(rec)
	if !ok {
		// The recorded external SDK no longer exists on disk (e.g. the
		// user uninstalled Android Studio) -- degrade to not-installed
		// rather than reporting a source that can't actually boot.
		return InstalledSDK{}, false
	}
	return InstalledSDK{
		Source:     SourceExternal,
		Root:       rec.Root,
		APILevel:   rec.APILevel,
		Tag:        rec.Tag,
		ABI:        rec.ABI,
		VersionKey: versionKey,
	}, true
}

// externalVersionKey re-validates that rec's SDK binaries and system image
// still exist on disk and, if so, returns a version fingerprint built from
// system.img's size and modification time -- deliberately not a full
// content hash, since hashing a 1-2GB system image on every boot would be
// far too slow for what's only ever compared with !=, never parsed.
func externalVersionKey(rec externalSDKRecord) (string, bool) {
	if !isRegularFile(filepath.Join(PlatformToolsDirIn(rec.Root), AdbBinaryName())) {
		return "", false
	}
	if !isRegularFile(filepath.Join(EmulatorDirIn(rec.Root), emulatorBinaryName())) {
		return "", false
	}
	imgDir := filepath.Join(rec.Root, fmt.Sprintf("system-images/android-%d/%s/%s", rec.APILevel, rec.Tag, rec.ABI))
	info, ok := systemImageFile(imgDir)
	if !ok {
		return "", false
	}
	return fmt.Sprintf("%s|%d|%d", imgDir, info.Size(), info.ModTime().UnixNano()), true
}
