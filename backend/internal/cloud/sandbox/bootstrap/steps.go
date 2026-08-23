package bootstrap

import (
	"net"
	"strconv"
)

// Steps is the ordered bring-up this configuration describes.
//
// The daemon comes first and gates on its own /readyz, because the published
// mux listener relays to the daemon's loopback /mux: reporting ready before the
// daemon answers would publish a terminal endpoint that 502s. The harness comes
// second and has no probe of its own — an agent CLI is "up" when it is running,
// and inventing a readiness signal for it here would mean guessing at a
// contract the agent adapters own.
func (c Config) Steps() []Step {
	steps := []Step{{
		Name:  "daemon",
		Argv:  c.DaemonArgv,
		Phase: PhaseDaemon,
		// AO_PORT is derived from DaemonAddr so one setting decides both where
		// the daemon listens and where the listener relays to. Configuring them
		// separately is how a sandbox ends up publishing a mux that points at
		// nothing.
		Env:      map[string]string{"AO_PORT": daemonPort(c.DaemonAddr)},
		ReadyURL: c.DaemonReadyURL(),
	}}
	if len(c.HarnessArgv) > 0 {
		steps = append(steps, Step{
			Name:  "harness",
			Argv:  c.HarnessArgv,
			Dir:   c.WorkspaceDir,
			Phase: PhaseHarness,
		})
	}
	return steps
}

// daemonPort extracts the port from an address, falling back to the daemon's
// own default when the address carries none.
func daemonPort(address string) string {
	_, port, err := net.SplitHostPort(address)
	if err != nil || port == "" {
		return "3001"
	}
	if _, err := strconv.Atoi(port); err != nil {
		return "3001"
	}
	return port
}
