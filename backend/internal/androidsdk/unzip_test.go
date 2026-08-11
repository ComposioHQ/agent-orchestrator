package androidsdk

import (
	"archive/zip"
	"os"
	"path/filepath"
	"testing"
)

func writeTestZip(t *testing.T, path string, files map[string]string) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	zw := zip.NewWriter(f)
	for name, content := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestUnzipExtractsNestedFiles(t *testing.T) {
	dir := t.TempDir()
	zipPath := filepath.Join(dir, "archive.zip")
	writeTestZip(t, zipPath, map[string]string{
		"platform-tools/adb.exe":        "fake adb binary",
		"platform-tools/NOTICE.txt":     "notices",
		"platform-tools/lib/nested.dll": "nested content",
	})

	destDir := filepath.Join(dir, "extracted")
	if err := unzip(zipPath, destDir); err != nil {
		t.Fatalf("unzip: %v", err)
	}

	got, err := os.ReadFile(filepath.Join(destDir, "platform-tools", "adb.exe"))
	if err != nil {
		t.Fatalf("read extracted file: %v", err)
	}
	if string(got) != "fake adb binary" {
		t.Errorf("adb.exe content = %q, want %q", got, "fake adb binary")
	}

	gotNested, err := os.ReadFile(filepath.Join(destDir, "platform-tools", "lib", "nested.dll"))
	if err != nil {
		t.Fatalf("read nested extracted file: %v", err)
	}
	if string(gotNested) != "nested content" {
		t.Errorf("nested.dll content = %q, want %q", gotNested, "nested content")
	}
}

func TestUnzipRejectsPathTraversal(t *testing.T) {
	dir := t.TempDir()
	zipPath := filepath.Join(dir, "malicious.zip")

	f, err := os.Create(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	w, err := zw.Create("../../escaped.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("escaped")); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	f.Close()

	destDir := filepath.Join(dir, "extracted")
	err = unzip(zipPath, destDir)
	if err == nil {
		t.Fatal("unzip: want an error for a zip-slip path-traversal entry, got nil")
	}
	if _, statErr := os.Stat(filepath.Join(dir, "escaped.txt")); !os.IsNotExist(statErr) {
		t.Error("path-traversal entry was written outside destDir")
	}
}
