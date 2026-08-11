package androidsdk

import "fmt"

// CheckDiskSpace returns an error if fewer than requiredBytes are free on the
// filesystem containing path.
// RequiredDiskSpace estimates the free space Install needs to download and
// unpack archives: each archive's compressed zip and its extracted contents
// briefly coexist on disk before the zip is deleted, so budgeting the raw sum
// alone would under-report peak usage. The 2x multiplier is a deliberately
// simple, conservative heuristic, not a precise compression-ratio model.
func RequiredDiskSpace(archives ...Archive) uint64 {
	var sum int64
	for _, a := range archives {
		sum += a.Size
	}
	return uint64(sum) * 2
}

func CheckDiskSpace(path string, requiredBytes uint64) error {
	free, err := FreeBytes(path)
	if err != nil {
		return err
	}
	if free < requiredBytes {
		return fmt.Errorf("androidsdk: insufficient disk space at %s: %d bytes free, %d required", path, free, requiredBytes)
	}
	return nil
}
