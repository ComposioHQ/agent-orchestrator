//go:build !windows

package codexappserver

import "os/exec"

func configureAppServerProcess(_ *exec.Cmd) {}
