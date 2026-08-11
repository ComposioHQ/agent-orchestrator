package androidsdk

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
)

// WriteLicenseHash writes the accepted-license marker file AGP/sdkmanager
// expect under <ANDROID_HOME>/licenses/<licenseID>: the file's content is the
// hex-encoded SHA-256 digest of the license's full text.
//
// NOTE: the SHA-256-of-full-text scheme matches every publicly documented
// description of this mechanism and the fixed 64-hex-char length of real
// license files, but has not been empirically verified against a real
// `./gradlew` run in this environment (no JDK/Android Gradle project
// available here). Per the plan, that verification is still owed before this
// is trusted in production — see Phase A1's stated manual verification step.
func WriteLicenseHash(licensesDir, licenseID, licenseText string) error {
	if err := os.MkdirAll(licensesDir, 0o755); err != nil {
		return fmt.Errorf("androidsdk: mkdir %s: %w", licensesDir, err)
	}
	sum := sha256.Sum256([]byte(licenseText))
	hash := hex.EncodeToString(sum[:])
	path := filepath.Join(licensesDir, licenseID)
	if err := os.WriteFile(path, []byte(hash), 0o644); err != nil {
		return fmt.Errorf("androidsdk: write license hash %s: %w", path, err)
	}
	return nil
}
