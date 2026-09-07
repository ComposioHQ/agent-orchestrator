//go:build !windows

package persistenthost

func providerHasConsoleWindow() bool { return false }
