package cli

import (
	"github.com/spf13/cobra"

	"github.com/aoagents/agent-orchestrator/backend/internal/daemon"
	"github.com/aoagents/agent-orchestrator/backend/internal/mobilebridge"
)

// newHeadlessCommand is the public, systemd-friendly headless entrypoint: it
// boots the normal loopback daemon and then enables authenticated remote
// access (LAN listener + Tailscale Secure Pairing), failing closed when HTTPS
// cannot be established. Unlike the hidden `ao daemon`, it is meant to be run
// by users and service managers directly.
func newHeadlessCommand() *cobra.Command {
	var remotePort int
	cmd := &cobra.Command{
		Use:   "headless",
		Short: "Run the AO daemon headless with authenticated remote access",
		Long: "Run the AO daemon in the foreground with remote access enabled: the authenticated " +
			"listener comes up behind Tailscale HTTPS (Secure Pairing), ready for the desktop and " +
			"mobile apps to connect. Startup fails closed if Tailscale HTTPS cannot be established.",
		Args: noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return daemon.RunHeadless(daemon.HeadlessOptions{
				RemotePort: remotePort,
				Out:        cmd.OutOrStdout(),
			})
		},
	}
	cmd.Flags().IntVar(&remotePort, "remote-port", mobilebridge.DefaultPort, "Port for the authenticated remote listener")
	return cmd
}
