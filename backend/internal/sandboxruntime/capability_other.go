//go:build !unix

package sandboxruntime

import (
	"fmt"
	"os"
)

func openCapabilityFile(string) (*os.File, os.FileInfo, uint32, error) {
	return nil, nil, 0, fmt.Errorf("%w: ao-sandbox requires a Unix runtime", ErrCapabilityInsecure)
}
