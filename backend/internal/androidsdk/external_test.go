package androidsdk

import (
	"path/filepath"
	"testing"
)

func TestExternalSDKMarkerPath(t *testing.T) {
	toolsDir := filepath.Join("C:", "fake", "tools")
	want := filepath.Join(toolsDir, "android", "external-sdk.json")
	if got := ExternalSDKMarkerPath(toolsDir); got != want {
		t.Errorf("ExternalSDKMarkerPath = %q, want %q", got, want)
	}
}

func TestWriteExternalSDKRecordThenRead(t *testing.T) {
	toolsDir := t.TempDir()
	d := DetectedSDK{
		Root: filepath.Join("C:", "Users", "me", "AppData", "Local", "Android", "Sdk"),
		SystemImage: DetectedSystemImage{
			APILevel: 34,
			Tag:      "google_apis",
			ABI:      "x86_64",
			RelPath:  "system-images/android-34/google_apis/x86_64/",
		},
	}
	if err := writeExternalSDKRecord(toolsDir, d); err != nil {
		t.Fatal(err)
	}

	rec, ok := readExternalSDKRecord(toolsDir)
	if !ok {
		t.Fatal("readExternalSDKRecord: ok = false, want true")
	}
	if rec.Root != d.Root || rec.APILevel != d.SystemImage.APILevel || rec.Tag != d.SystemImage.Tag || rec.ABI != d.SystemImage.ABI {
		t.Errorf("readExternalSDKRecord = %+v, want fields matching %+v", rec, d)
	}
}

func TestReadExternalSDKRecordWhenAbsent(t *testing.T) {
	if _, ok := readExternalSDKRecord(t.TempDir()); ok {
		t.Error("readExternalSDKRecord: ok = true, want false when no marker was written")
	}
}
