package androidemulator

import (
	"context"
	"os/exec"
	"strings"
)

// AccelStatus reports whether hardware virtualization acceleration is
// available for the emulator on this host.
type AccelStatus struct {
	Available bool
	// Detail is the tool's raw diagnostic text, surfaced to the user so a
	// "no" answer is actionable (e.g. "enable Windows Hypervisor Platform")
	// rather than a bare boolean.
	Detail string
}

// CheckAcceleration shells out to the emulator's own -accel-check rather than
// reimplementing per-OS hypervisor detection (WHPX/KVM/HVF) -- confirmed
// during the A0 spike that this is the emulator's real, authoritative check,
// used before every real boot.
func CheckAcceleration(ctx context.Context, emulatorPath string) (AccelStatus, error) {
	cmd := exec.CommandContext(ctx, emulatorPath, "-accel-check")
	output, err := cmd.CombinedOutput()
	return parseAccelCheckOutput(output, err), nil
}

// parseAccelCheckOutput is the pure, testable core of CheckAcceleration.
//
// NOTE: the "available" case is verified against real output captured on
// this Windows machine during the A0 spike. The "unavailable" case's exact
// output/exit-code shape was not observed directly (this dev machine has
// working WHPX) -- parsing here is deliberately conservative: require BOTH a
// zero exit AND the tool's own positive "is installed and usable" marker, so
// an unexpected output format fails closed (treated as unavailable) rather
// than open. This should be cross-checked against a real "no virtualization"
// host before shipping, per the plan's stated manual verification step.
func parseAccelCheckOutput(output []byte, runErr error) AccelStatus {
	detail := strings.TrimSpace(string(output))
	if runErr != nil {
		return AccelStatus{Available: false, Detail: detail}
	}
	if strings.Contains(detail, "is installed and usable") {
		return AccelStatus{Available: true, Detail: detail}
	}
	return AccelStatus{Available: false, Detail: detail}
}
