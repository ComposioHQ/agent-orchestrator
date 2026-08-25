//go:build windows

package tmux

// Windows selects ConPTY rather than tmux. Keep the adapter buildable for
// cross-platform compile checks without adding Unix alias behavior here.
func privateSocketAddress(socketPath string) (string, error) {
	return socketPath, nil
}
