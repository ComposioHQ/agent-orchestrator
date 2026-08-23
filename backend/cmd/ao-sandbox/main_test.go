package main

import (
	"slices"
	"testing"
)

func TestParseOptionsLaunchContractContainsNoCapabilityValue(t *testing.T) {
	args := []string{
		"--control-plane-url", "https://control.example",
		"--sandbox-id", "sandbox-1",
		"--workspace-id", "workspace-1",
		"--session-id", "session-1",
		"--", "/bin/sh",
	}
	opts, err := parseOptions(args)
	if err != nil {
		t.Fatal(err)
	}
	if opts.controlPlaneURL != "https://control.example" || opts.sessionID != "session-1" {
		t.Fatalf("options = %#v", opts)
	}
	if slices.Contains(args, "--capability") || slices.Contains(args, "--capability-file") {
		t.Fatalf("launch arguments carry capability configuration: %v", args)
	}
}

func TestParseOptionsRequiresAbsoluteCommandAndPlacementBinding(t *testing.T) {
	base := []string{
		"--control-plane-url", "https://control.example",
		"--sandbox-id", "sandbox-1",
		"--workspace-id", "workspace-1",
		"--session-id", "session-1",
		"--",
	}
	if _, err := parseOptions(append(base, "relative-agent")); err == nil {
		t.Fatal("relative executable was accepted")
	}
	if _, err := parseOptions([]string{"--", "/bin/sh"}); err == nil {
		t.Fatal("missing placement binding was accepted")
	}
}
