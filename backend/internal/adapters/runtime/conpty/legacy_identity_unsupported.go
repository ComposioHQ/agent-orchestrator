//go:build !darwin && !windows && !linux

package conpty

import (
	"context"
	"fmt"
)

func collectLegacyHostIdentity(context.Context, *hostSession, StatusPayload) (legacyHostIdentityEvidence, error) {
	return legacyHostIdentityEvidence{}, fmt.Errorf("protocol-v2 pty-host recovery is unsupported on this platform")
}

func revalidateLegacyHostIdentity(context.Context, *hostSession, StatusPayload, legacyHostIdentityFingerprint) error {
	return fmt.Errorf("protocol-v2 pty-host recovery is unsupported on this platform")
}
