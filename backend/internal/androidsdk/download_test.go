package androidsdk

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func sha1Hex(data []byte) string {
	sum := sha1.Sum(data)
	return hex.EncodeToString(sum[:])
}

func TestDownloadArchiveFreshDownloadVerifiesChecksum(t *testing.T) {
	content := []byte("android sdk archive contents, spike-verified structure")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(content)
	}))
	defer srv.Close()

	dir := t.TempDir()
	dest := filepath.Join(dir, "platform-tools.zip")
	archive := Archive{URL: "platform-tools.zip", SHA1: sha1Hex(content), Size: int64(len(content))}

	if err := DownloadArchive(context.Background(), srv.Client(), srv.URL+"/", archive, dest, nil); err != nil {
		t.Fatalf("DownloadArchive: %v", err)
	}

	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(got) != string(content) {
		t.Errorf("downloaded content = %q, want %q", got, content)
	}
}

func TestDownloadArchiveChecksumMismatchLeavesNoDestFile(t *testing.T) {
	content := []byte("this is not what the manifest promised")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(content)
	}))
	defer srv.Close()

	dir := t.TempDir()
	dest := filepath.Join(dir, "platform-tools.zip")
	archive := Archive{URL: "platform-tools.zip", SHA1: "0000000000000000000000000000000000dead", Size: int64(len(content))}

	err := DownloadArchive(context.Background(), srv.Client(), srv.URL+"/", archive, dest, nil)
	if err == nil {
		t.Fatal("DownloadArchive: want a checksum-mismatch error, got nil")
	}
	if _, statErr := os.Stat(dest); !os.IsNotExist(statErr) {
		t.Errorf("dest file exists after a checksum mismatch, want it absent (never rename bad data into place)")
	}
	if _, statErr := os.Stat(dest + ".part"); !os.IsNotExist(statErr) {
		t.Errorf(".part file still exists after a checksum mismatch, want it removed so a retry starts clean instead of resuming corrupted bytes forever")
	}
}

func TestDownloadArchiveSkipsIfDestAlreadyExists(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	dir := t.TempDir()
	dest := filepath.Join(dir, "platform-tools.zip")
	if err := os.WriteFile(dest, []byte("already installed"), 0o644); err != nil {
		t.Fatal(err)
	}
	archive := Archive{URL: "platform-tools.zip", SHA1: "irrelevant-when-dest-already-present", Size: 123}

	if err := DownloadArchive(context.Background(), srv.Client(), srv.URL+"/", archive, dest, nil); err != nil {
		t.Fatalf("DownloadArchive: %v", err)
	}
	if called {
		t.Error("server was contacted even though dest already existed — download should have been skipped")
	}
}

func TestDownloadArchiveResumesPartialDownload(t *testing.T) {
	content := []byte(strings.Repeat("resumable-android-sdk-bytes-", 200)) // long enough for a meaningful partial
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rangeHeader := r.Header.Get("Range")
		if rangeHeader == "" {
			w.Write(content)
			return
		}
		var start int64
		if _, err := fmt.Sscanf(rangeHeader, "bytes=%d-", &start); err != nil {
			t.Errorf("server: bad Range header %q", rangeHeader)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Range", "bytes "+strconv.FormatInt(start, 10)+"-/"+strconv.Itoa(len(content)))
		w.WriteHeader(http.StatusPartialContent)
		w.Write(content[start:])
	}))
	defer srv.Close()

	dir := t.TempDir()
	dest := filepath.Join(dir, "emulator.zip")
	partial := dest + ".part"
	firstHalf := content[:len(content)/2]
	if err := os.WriteFile(partial, firstHalf, 0o644); err != nil {
		t.Fatal(err)
	}

	archive := Archive{URL: "emulator.zip", SHA1: sha1Hex(content), Size: int64(len(content))}
	if err := DownloadArchive(context.Background(), srv.Client(), srv.URL+"/", archive, dest, nil); err != nil {
		t.Fatalf("DownloadArchive: %v", err)
	}

	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(got) != string(content) {
		t.Errorf("resumed download content mismatch: got %d bytes, want %d bytes", len(got), len(content))
	}
	if _, statErr := os.Stat(partial); !os.IsNotExist(statErr) {
		t.Errorf(".part file still exists after successful completion, want it cleaned up")
	}
}

func TestDownloadArchiveProgressCallback(t *testing.T) {
	content := []byte(strings.Repeat("x", 1000))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(content)
	}))
	defer srv.Close()

	dir := t.TempDir()
	dest := filepath.Join(dir, "sysimg.zip")
	archive := Archive{URL: "sysimg.zip", SHA1: sha1Hex(content), Size: int64(len(content))}

	var lastDone int64
	calls := 0
	err := DownloadArchive(context.Background(), srv.Client(), srv.URL+"/", archive, dest, func(p DownloadProgress) {
		calls++
		lastDone = p.BytesDone
		if p.BytesTotal != int64(len(content)) {
			t.Errorf("progress BytesTotal = %d, want %d", p.BytesTotal, len(content))
		}
	})
	if err != nil {
		t.Fatalf("DownloadArchive: %v", err)
	}
	if calls == 0 {
		t.Error("progress callback was never called")
	}
	if lastDone != int64(len(content)) {
		t.Errorf("final progress BytesDone = %d, want %d", lastDone, len(content))
	}
}
