package androidsdk

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
)

// DownloadProgress reports the state of an in-flight download.
type DownloadProgress struct {
	BytesDone  int64
	BytesTotal int64
}

// DownloadArchive downloads archive (resolved against baseURL) to destPath,
// verifying its SHA1 checksum before making it visible at destPath.
//
// Idempotent: if destPath already exists, the download is skipped entirely —
// no request is made. This relies on the invariant that destPath is only ever
// created by a rename from the ".part" temp file after successful checksum
// verification (see below), so its mere existence proves it was already
// verified; re-hashing a potentially multi-hundred-MB file on every call
// would be wasteful.
//
// Resumable: partial progress is written to destPath+".part". If that file
// already exists when DownloadArchive is called again (e.g. after a daemon
// restart mid-download), the download resumes via an HTTP Range request
// instead of restarting from zero. If the server does not honor the Range
// request (unexpected 200 instead of 206), the partial file is discarded and
// the download restarts from zero rather than corrupting the output.
//
// progress, if non-nil, is invoked periodically as bytes are written.
func DownloadArchive(ctx context.Context, client *http.Client, baseURL string, archive Archive, destPath string, progress func(DownloadProgress)) error {
	if _, err := os.Stat(destPath); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("androidsdk: stat %s: %w", destPath, err)
	}

	partPath := destPath + ".part"
	var startOffset int64
	if fi, err := os.Stat(partPath); err == nil {
		startOffset = fi.Size()
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("androidsdk: stat %s: %w", partPath, err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+archive.URL, nil)
	if err != nil {
		return fmt.Errorf("androidsdk: build request for %s: %w", archive.URL, err)
	}
	if startOffset > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", startOffset))
	}

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("androidsdk: download %s: %w", archive.URL, err)
	}
	defer resp.Body.Close()

	openFlag := os.O_CREATE | os.O_WRONLY
	switch resp.StatusCode {
	case http.StatusOK:
		// Either this was a from-scratch request, or the server ignored our
		// Range request. Either way, resp.Body is the full content: start
		// the part file fresh so we don't prepend stale bytes.
		startOffset = 0
		openFlag |= os.O_TRUNC
	case http.StatusPartialContent:
		openFlag |= os.O_APPEND
	default:
		return fmt.Errorf("androidsdk: download %s: unexpected status %s", archive.URL, resp.Status)
	}

	f, err := os.OpenFile(partPath, openFlag, 0o644)
	if err != nil {
		return fmt.Errorf("androidsdk: open %s: %w", partPath, err)
	}

	hasher := sha1.New()
	if startOffset > 0 {
		// Re-hash the bytes already on disk so the final checksum covers the
		// whole file, not just what this call downloaded.
		existing, err := os.Open(partPath)
		if err != nil {
			f.Close()
			return fmt.Errorf("androidsdk: reopen %s for hashing: %w", partPath, err)
		}
		if _, err := io.CopyN(hasher, existing, startOffset); err != nil {
			existing.Close()
			f.Close()
			return fmt.Errorf("androidsdk: hash existing partial %s: %w", partPath, err)
		}
		existing.Close()
	}

	done := startOffset
	total := archive.Size
	buf := make([]byte, 32*1024)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, err := f.Write(buf[:n]); err != nil {
				f.Close()
				return fmt.Errorf("androidsdk: write %s: %w", partPath, err)
			}
			hasher.Write(buf[:n])
			done += int64(n)
			if progress != nil {
				progress(DownloadProgress{BytesDone: done, BytesTotal: total})
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			f.Close()
			return fmt.Errorf("androidsdk: read body for %s: %w", archive.URL, readErr)
		}
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("androidsdk: close %s: %w", partPath, err)
	}

	if got := hex.EncodeToString(hasher.Sum(nil)); got != archive.SHA1 {
		// Remove the partial file rather than leaving it in place: a later
		// retry must start clean, not resume-and-trust bytes that just failed
		// verification.
		if rmErr := os.Remove(partPath); rmErr != nil && !os.IsNotExist(rmErr) {
			return fmt.Errorf("androidsdk: checksum mismatch for %s (got %s, want %s); also failed to remove %s: %w",
				archive.URL, got, archive.SHA1, partPath, rmErr)
		}
		return fmt.Errorf("androidsdk: checksum mismatch for %s: got %s, want %s", archive.URL, got, archive.SHA1)
	}

	if err := os.Rename(partPath, destPath); err != nil {
		return fmt.Errorf("androidsdk: rename %s to %s: %w", partPath, destPath, err)
	}
	return nil
}
