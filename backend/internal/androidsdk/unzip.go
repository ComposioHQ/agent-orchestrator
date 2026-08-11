package androidsdk

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// unzip extracts the zip archive at zipPath into destDir, creating destDir
// (and any needed parents) if necessary. Entries whose name would resolve
// outside destDir (a "zip-slip" path-traversal entry) are rejected rather
// than silently skipped, since Google's own manifest-listed archives should
// never contain one — its presence would mean the archive is not what the
// manifest promised, checksum notwithstanding.
func unzip(zipPath, destDir string) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return fmt.Errorf("androidsdk: open zip %s: %w", zipPath, err)
	}
	defer r.Close()

	destAbs, err := filepath.Abs(destDir)
	if err != nil {
		return fmt.Errorf("androidsdk: resolve dest dir %s: %w", destDir, err)
	}

	for _, entry := range r.File {
		target := filepath.Join(destAbs, entry.Name)
		if target != destAbs && !strings.HasPrefix(target, destAbs+string(filepath.Separator)) {
			return fmt.Errorf("androidsdk: zip entry %q in %s escapes destination directory", entry.Name, zipPath)
		}

		if entry.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return fmt.Errorf("androidsdk: mkdir %s: %w", target, err)
			}
			continue
		}

		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return fmt.Errorf("androidsdk: mkdir %s: %w", filepath.Dir(target), err)
		}

		if err := extractZipFile(entry, target); err != nil {
			return err
		}
	}
	return nil
}

func extractZipFile(entry *zip.File, target string) error {
	src, err := entry.Open()
	if err != nil {
		return fmt.Errorf("androidsdk: open zip entry %s: %w", entry.Name, err)
	}
	defer src.Close()

	dst, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, entry.Mode().Perm()|0o600)
	if err != nil {
		return fmt.Errorf("androidsdk: create %s: %w", target, err)
	}
	defer dst.Close()

	if _, err := io.Copy(dst, src); err != nil {
		return fmt.Errorf("androidsdk: extract %s: %w", target, err)
	}
	return nil
}
