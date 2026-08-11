package androidsdk

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
)

// InstallConfig configures a single Install call. URLs are injectable
// (rather than hardcoded) so Install is testable against a local httptest
// server; production wiring points them at the real dl.google.com paths.
type InstallConfig struct {
	Client                *http.Client
	RepositoryManifestURL string
	SysImgManifestURL     string
	DownloadBaseURL       string
	SysImgDownloadBaseURL string
	ToolsDir              string
	Platform              Platform
	APILevel              int
	Tag                   string
	// AcceptLicenses must be explicitly true or Install refuses to make any
	// network request or write anything. AO never downloads or accepts SDK
	// licenses on a user's behalf silently.
	AcceptLicenses bool
	// Progress, if non-nil, is invoked as each component downloads.
	Progress func(component string, p DownloadProgress)
}

// installedManifest is the on-disk idempotency record at ManifestPath: which
// exact component versions (by checksum) are currently installed. Its
// presence with matching checksums is what lets Install skip re-downloading
// already-installed components entirely.
type installedManifest struct {
	PlatformToolsSHA1 string `json:"platformToolsSha1"`
	EmulatorSHA1      string `json:"emulatorSha1"`
	SystemImageSHA1   string `json:"systemImageSha1"`
	APILevel          int    `json:"apiLevel"`
	Tag               string `json:"tag"`
	ABI               string `json:"abi"`
}

// Install downloads, verifies, and unpacks the Android SDK components AO
// needs (platform-tools, emulator, one system image) under cfg.ToolsDir, then
// writes accepted-license hash files and an idempotency manifest.
func Install(ctx context.Context, cfg InstallConfig) error {
	if !cfg.AcceptLicenses {
		return fmt.Errorf("androidsdk: install requires explicit license acceptance")
	}

	repoManifest, err := fetchManifest(ctx, cfg.Client, cfg.RepositoryManifestURL)
	if err != nil {
		return fmt.Errorf("androidsdk: fetch repository manifest: %w", err)
	}
	sysimgManifest, err := fetchManifest(ctx, cfg.Client, cfg.SysImgManifestURL)
	if err != nil {
		return fmt.Errorf("androidsdk: fetch system image manifest: %w", err)
	}

	ptArchive, err := repoManifest.ResolvePlatformTools(cfg.Platform)
	if err != nil {
		return err
	}
	emuArchive, err := repoManifest.ResolveEmulator(cfg.Platform)
	if err != nil {
		return err
	}
	sysArchive, err := sysimgManifest.ResolveSystemImage(cfg.APILevel, cfg.Tag, cfg.Platform)
	if err != nil {
		return err
	}

	want := installedManifest{
		PlatformToolsSHA1: ptArchive.SHA1,
		EmulatorSHA1:      emuArchive.SHA1,
		SystemImageSHA1:   sysArchive.SHA1,
		APILevel:          cfg.APILevel,
		Tag:               cfg.Tag,
		ABI:               cfg.Platform.SysImgABI,
	}
	if existing, ok := readInstalledManifest(cfg.ToolsDir); ok && existing == want {
		return nil
	}

	if err := os.MkdirAll(Dir(cfg.ToolsDir), 0o755); err != nil {
		return fmt.Errorf("androidsdk: mkdir %s: %w", Dir(cfg.ToolsDir), err)
	}
	if err := CheckDiskSpace(Dir(cfg.ToolsDir), RequiredDiskSpace(ptArchive, emuArchive, sysArchive)); err != nil {
		return err
	}

	if err := downloadAndExtract(ctx, cfg, "platform-tools", ptArchive, cfg.DownloadBaseURL, PlatformToolsDir(cfg.ToolsDir)); err != nil {
		return err
	}
	if err := downloadAndExtract(ctx, cfg, "emulator", emuArchive, cfg.DownloadBaseURL, EmulatorDir(cfg.ToolsDir)); err != nil {
		return err
	}
	sysImgDir := SystemImageDir(cfg.ToolsDir, cfg.APILevel, cfg.Tag, cfg.Platform.SysImgABI)
	if err := downloadAndExtract(ctx, cfg, "system-image", sysArchive, cfg.SysImgDownloadBaseURL, sysImgDir); err != nil {
		return err
	}

	for _, licenseID := range uniqueLicenseIDs(ptArchive, emuArchive, sysArchive) {
		text, ok := repoManifest.LicenseText(licenseID)
		if !ok {
			text, ok = sysimgManifest.LicenseText(licenseID)
		}
		if !ok {
			return fmt.Errorf("androidsdk: package references unknown license %q", licenseID)
		}
		if err := WriteLicenseHash(LicensesDir(cfg.ToolsDir), licenseID, text); err != nil {
			return err
		}
	}

	if err := writeInstalledManifest(cfg.ToolsDir, want); err != nil {
		return err
	}
	return nil
}

func downloadAndExtract(ctx context.Context, cfg InstallConfig, component string, archive Archive, baseURL, destDir string) error {
	zipPath := filepath.Join(Dir(cfg.ToolsDir), ".downloads", component+".zip")
	if err := os.MkdirAll(filepath.Dir(zipPath), 0o755); err != nil {
		return fmt.Errorf("androidsdk: mkdir %s: %w", filepath.Dir(zipPath), err)
	}

	var progress func(DownloadProgress)
	if cfg.Progress != nil {
		progress = func(p DownloadProgress) { cfg.Progress(component, p) }
	}
	if err := DownloadArchive(ctx, cfg.Client, baseURL, archive, zipPath, progress); err != nil {
		return fmt.Errorf("androidsdk: download %s: %w", component, err)
	}

	// A stale extraction from a previous, different version must not linger
	// alongside newly-extracted files.
	if err := os.RemoveAll(destDir); err != nil {
		return fmt.Errorf("androidsdk: clear stale %s dir: %w", component, err)
	}
	// Google's own archives already wrap their contents in a top-level folder
	// matching destDir's own leaf name (confirmed empirically during the A0
	// spike: platform-tools.zip contains a "platform-tools/" folder, emulator
	// zips contain "emulator/", system-image zips contain the ABI name e.g.
	// "x86_64/"). Extracting into destDir itself would double-nest it, so
	// extract into its parent instead and let the archive's own folder become
	// destDir.
	if err := unzip(zipPath, filepath.Dir(destDir)); err != nil {
		return fmt.Errorf("androidsdk: extract %s: %w", component, err)
	}
	if err := os.Remove(zipPath); err != nil {
		return fmt.Errorf("androidsdk: remove downloaded %s zip: %w", component, err)
	}
	return nil
}

func uniqueLicenseIDs(archives ...Archive) []string {
	seen := make(map[string]bool, len(archives))
	var ids []string
	for _, a := range archives {
		if a.LicenseID == "" || seen[a.LicenseID] {
			continue
		}
		seen[a.LicenseID] = true
		ids = append(ids, a.LicenseID)
	}
	return ids
}

func fetchManifest(ctx context.Context, client *http.Client, url string) (Manifest, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return Manifest{}, fmt.Errorf("androidsdk: build manifest request for %s: %w", url, err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return Manifest{}, fmt.Errorf("androidsdk: fetch %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Manifest{}, fmt.Errorf("androidsdk: fetch %s: unexpected status %s", url, resp.Status)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return Manifest{}, fmt.Errorf("androidsdk: read manifest body from %s: %w", url, err)
	}
	return ParseManifest(body)
}

func readInstalledManifest(toolsDir string) (installedManifest, bool) {
	data, err := os.ReadFile(ManifestPath(toolsDir))
	if err != nil {
		return installedManifest{}, false
	}
	var m installedManifest
	if err := json.Unmarshal(data, &m); err != nil {
		return installedManifest{}, false
	}
	return m, true
}

func writeInstalledManifest(toolsDir string, m installedManifest) error {
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return fmt.Errorf("androidsdk: marshal install manifest: %w", err)
	}
	if err := os.MkdirAll(Dir(toolsDir), 0o755); err != nil {
		return fmt.Errorf("androidsdk: mkdir %s: %w", Dir(toolsDir), err)
	}
	if err := os.WriteFile(ManifestPath(toolsDir), data, 0o644); err != nil {
		return fmt.Errorf("androidsdk: write install manifest: %w", err)
	}
	return nil
}
