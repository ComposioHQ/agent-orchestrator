package androidsdk

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// externalSDKRecord is the on-disk record of an adopted external SDK,
// written by UseExternal. It lives under AO's own owned Dir(toolsDir) tree
// (a sibling of .ao-manifest.json, licenses/, .downloads/, avd/) -- never
// inside the detected external root, which AO only ever reads from.
type externalSDKRecord struct {
	Root     string `json:"root"`
	APILevel int    `json:"apiLevel"`
	Tag      string `json:"tag"`
	ABI      string `json:"abi"`
}

// ExternalSDKMarkerPath is where an adopted external SDK's identity is
// recorded, so it survives a daemon restart.
func ExternalSDKMarkerPath(toolsDir string) string {
	return filepath.Join(Dir(toolsDir), "external-sdk.json")
}

func writeExternalSDKRecord(toolsDir string, d DetectedSDK) error {
	rec := externalSDKRecord{
		Root:     d.Root,
		APILevel: d.SystemImage.APILevel,
		Tag:      d.SystemImage.Tag,
		ABI:      d.SystemImage.ABI,
	}
	data, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return fmt.Errorf("androidsdk: marshal external sdk record: %w", err)
	}
	if err := os.MkdirAll(Dir(toolsDir), 0o750); err != nil {
		return fmt.Errorf("androidsdk: mkdir %s: %w", Dir(toolsDir), err)
	}
	if err := os.WriteFile(ExternalSDKMarkerPath(toolsDir), data, 0o600); err != nil {
		return fmt.Errorf("androidsdk: write external sdk marker: %w", err)
	}
	return nil
}

func readExternalSDKRecord(toolsDir string) (externalSDKRecord, bool) {
	data, err := os.ReadFile(ExternalSDKMarkerPath(toolsDir))
	if err != nil {
		return externalSDKRecord{}, false
	}
	var rec externalSDKRecord
	if err := json.Unmarshal(data, &rec); err != nil {
		return externalSDKRecord{}, false
	}
	return rec, true
}
