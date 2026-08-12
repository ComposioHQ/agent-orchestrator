package androidsdk

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// maxExtractedFileBytes is a hard per-file ceiling on decompressed output,
// independent of anything the zip's own (attacker-influenceable) metadata
// claims. Extracted archives are Google's own SHA1-verified SDK packages
// (platform-tools/emulator/system-image, at most a couple GB each), so this
// is generous headroom, not a tight fit -- a circuit breaker against a
// decompression bomb, not a realistic limit for a legitimate package.
const maxExtractedFileBytes = 8 << 30 // 8GiB

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
	defer func() { _ = r.Close() }()

	destAbs, err := filepath.Abs(destDir)
	if err != nil {
		return fmt.Errorf("androidsdk: resolve dest dir %s: %w", destDir, err)
	}

	for _, entry := range r.File {
		//nolint:gosec // G305: target is verified below to stay within destAbs before any use
		target := filepath.Join(destAbs, entry.Name)
		if target != destAbs && !strings.HasPrefix(target, destAbs+string(filepath.Separator)) {
			return fmt.Errorf("androidsdk: zip entry %q in %s escapes destination directory", entry.Name, zipPath)
		}

		if entry.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o750); err != nil {
				return fmt.Errorf("androidsdk: mkdir %s: %w", target, err)
			}
			continue
		}

		if err := os.MkdirAll(filepath.Dir(target), 0o750); err != nil {
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
	defer func() { _ = src.Close() }()

	dst, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, entry.Mode().Perm()|0o600)
	if err != nil {
		return fmt.Errorf("androidsdk: create %s: %w", target, err)
	}
	defer func() { _ = dst.Close() }()

	// Cap decompressed output at maxExtractedFileBytes regardless of what the
	// entry's own (attacker-influenceable) metadata claims -- a circuit
	// breaker against a decompression bomb, not a realistic limit for a
	// legitimate package (see the constant's doc comment).
	written, err := io.CopyN(dst, src, maxExtractedFileBytes+1)
	if err != nil && err != io.EOF {
		return fmt.Errorf("androidsdk: extract %s: %w", target, err)
	}
	if written > maxExtractedFileBytes {
		return fmt.Errorf("androidsdk: zip entry %s exceeds %d byte extraction limit", entry.Name, maxExtractedFileBytes)
	}
	return nil
}
