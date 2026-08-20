package cli

import (
	"fmt"

	"github.com/spf13/cobra"
)

// remoteStatus mirrors controllers.MobileStatusResponse across the deliberate
// hand-mirrored CLI/HTTP DTO boundary (AGENTS.md): the CLI talks to the
// daemon's loopback /api/v1/mobile/* routes but presents generalized "remote
// access" language. Field names here are asserted against the real router by
// the wire test in remote_test.go.
type remoteStatus struct {
	Enabled       bool   `json:"enabled"`
	Host          string `json:"host"`
	TailscaleHost string `json:"tailscaleHost"`
	Port          int    `json:"port"`
	// Password is populated by the daemon while remote access is enabled. Only
	// `ao remote credentials` and `ao remote rotate` may print it; `status`
	// clears it before rendering. omitempty keeps the redaction visible in
	// --json output as an absent field.
	Password      string `json:"password,omitempty"`
	Warning       string `json:"warning"`
	SecurePairing struct {
		Enabled   bool   `json:"enabled"`
		Available bool   `json:"available"`
		Active    bool   `json:"active"`
		Host      string `json:"host"`
		Port      int    `json:"port"`
		Reason    string `json:"reason"`
	} `json:"securePairing"`
}

// remoteCredentials is the output shape of `ao remote credentials [--json]`
// and `ao remote rotate [--json]`.
type remoteCredentials struct {
	URL      string `json:"url"`
	Password string `json:"password"`
}

// pairingURL prefers the verified Tailscale HTTPS endpoint and falls back to
// the plaintext listener addresses. Empty when remote access is disabled or
// no address is known.
func pairingURL(st remoteStatus) string {
	if st.SecurePairing.Active && st.SecurePairing.Host != "" {
		return "https://" + st.SecurePairing.Host
	}
	host := st.TailscaleHost
	if host == "" {
		host = st.Host
	}
	if host == "" || st.Port == 0 {
		return ""
	}
	return fmt.Sprintf("http://%s:%d", host, st.Port)
}

func (c *commandContext) fetchRemoteStatus(cmd *cobra.Command) (remoteStatus, error) {
	var st remoteStatus
	if err := c.getJSON(cmd.Context(), "mobile/status", &st); err != nil {
		return remoteStatus{}, err
	}
	return st, nil
}

func newRemoteCommand(ctx *commandContext) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "remote",
		Short: "Manage remote access to this daemon",
		Long: "Manage the daemon's authenticated remote listener (desktop and mobile pairing). " +
			"Run the daemon with `ao headless` to enable remote access with Tailscale HTTPS at boot.",
		Args: noArgs,
	}
	cmd.AddCommand(newRemoteStatusCommand(ctx))
	cmd.AddCommand(newRemoteCredentialsCommand(ctx))
	cmd.AddCommand(newRemoteRotateCommand(ctx))
	cmd.AddCommand(newRemoteEnableCommand(ctx))
	cmd.AddCommand(newRemoteDisableCommand(ctx))
	return cmd
}

func newRemoteStatusCommand(ctx *commandContext) *cobra.Command {
	var jsonOut bool
	cmd := &cobra.Command{
		Use:   "status",
		Short: "Show remote access state (password redacted)",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			st, err := ctx.fetchRemoteStatus(cmd)
			if err != nil {
				return err
			}
			st.Password = "" // status never prints the password
			if jsonOut {
				return writeJSON(cmd.OutOrStdout(), st)
			}
			return writeRemoteStatus(cmd, st)
		},
	}
	cmd.Flags().BoolVar(&jsonOut, "json", false, "Output status as JSON")
	return cmd
}

func newRemoteCredentialsCommand(ctx *commandContext) *cobra.Command {
	var jsonOut bool
	cmd := &cobra.Command{
		Use:   "credentials",
		Short: "Print the remote pairing URL and connection password",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			st, err := ctx.fetchRemoteStatus(cmd)
			if err != nil {
				return err
			}
			if !st.Enabled {
				return fmt.Errorf("remote access is not enabled — run `ao remote enable`, or start the daemon with `ao headless`")
			}
			creds := remoteCredentials{URL: pairingURL(st), Password: st.Password}
			if jsonOut {
				return writeJSON(cmd.OutOrStdout(), creds)
			}
			return writeRemoteCredentials(cmd, creds)
		},
	}
	cmd.Flags().BoolVar(&jsonOut, "json", false, "Output credentials as JSON")
	return cmd
}

func newRemoteRotateCommand(ctx *commandContext) *cobra.Command {
	var jsonOut bool
	cmd := &cobra.Command{
		Use:   "rotate",
		Short: "Rotate the remote connection password and print the new credentials once",
		Long: "Rotate the shared desktop/mobile connection password. Every currently paired " +
			"client is dropped and must reconnect with the new password.",
		Args: noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			var st remoteStatus
			if err := ctx.postJSON(cmd.Context(), "mobile/regenerate", nil, &st); err != nil {
				return err
			}
			creds := remoteCredentials{URL: pairingURL(st), Password: st.Password}
			if jsonOut {
				return writeJSON(cmd.OutOrStdout(), creds)
			}
			return writeRemoteCredentials(cmd, creds)
		},
	}
	cmd.Flags().BoolVar(&jsonOut, "json", false, "Output the new credentials as JSON")
	return cmd
}

func newRemoteEnableCommand(ctx *commandContext) *cobra.Command {
	return &cobra.Command{
		Use:   "enable",
		Short: "Enable the authenticated remote listener",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			var st remoteStatus
			if err := ctx.postJSON(cmd.Context(), "mobile/enable", nil, &st); err != nil {
				return err
			}
			out := cmd.OutOrStdout()
			if _, err := fmt.Fprintln(out, "Remote access enabled."); err != nil {
				return err
			}
			if url := pairingURL(st); url != "" {
				if _, err := fmt.Fprintf(out, "  Pairing URL: %s\n", url); err != nil {
					return err
				}
			}
			if !st.SecurePairing.Active {
				if _, err := fmt.Fprintln(out, "  Warning: Tailscale HTTPS (secure pairing) is not active — see `ao remote status`."); err != nil {
					return err
				}
			}
			_, err := fmt.Fprintln(out, "  Retrieve the connection password with: ao remote credentials")
			return err
		},
	}
}

func newRemoteDisableCommand(ctx *commandContext) *cobra.Command {
	return &cobra.Command{
		Use:   "disable",
		Short: "Disable the authenticated remote listener",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			var st remoteStatus
			if err := ctx.postJSON(cmd.Context(), "mobile/disable", nil, &st); err != nil {
				return err
			}
			_, err := fmt.Fprintln(cmd.OutOrStdout(), "Remote access disabled.")
			return err
		},
	}
}

func writeRemoteStatus(cmd *cobra.Command, st remoteStatus) error {
	out := cmd.OutOrStdout()
	enabled := "disabled"
	if st.Enabled {
		enabled = "enabled"
	}
	if _, err := fmt.Fprintf(out, "Remote access: %s\n", enabled); err != nil {
		return err
	}
	if !st.Enabled {
		return nil
	}
	if url := pairingURL(st); url != "" {
		if _, err := fmt.Fprintf(out, "  pairing URL: %s\n", url); err != nil {
			return err
		}
	}
	if _, err := fmt.Fprintf(out, "  listener port: %d\n", st.Port); err != nil {
		return err
	}
	sp := st.SecurePairing
	switch {
	case sp.Active:
		if _, err := fmt.Fprintf(out, "  secure pairing: active (https://%s)\n", sp.Host); err != nil {
			return err
		}
	case !sp.Enabled:
		if _, err := fmt.Fprintln(out, "  secure pairing: off"); err != nil {
			return err
		}
	case !sp.Available:
		if _, err := fmt.Fprintf(out, "  secure pairing: unavailable (%s)\n", sp.Reason); err != nil {
			return err
		}
	default:
		if _, err := fmt.Fprintf(out, "  secure pairing: not active (%s)\n", sp.Reason); err != nil {
			return err
		}
	}
	_, err := fmt.Fprintln(out, "  Retrieve the connection password with: ao remote credentials")
	return err
}

func writeRemoteCredentials(cmd *cobra.Command, creds remoteCredentials) error {
	out := cmd.OutOrStdout()
	if creds.URL != "" {
		if _, err := fmt.Fprintf(out, "Pairing URL: %s\n", creds.URL); err != nil {
			return err
		}
	}
	_, err := fmt.Fprintf(out, "Password: %s\n", creds.Password)
	return err
}
