//go:build windows

package process

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestCommandContextHidesConsoleWindow(t *testing.T) {
	cmd := CommandContext(context.Background(), "git", "--version")
	if cmd.SysProcAttr == nil {
		t.Fatal("SysProcAttr = nil, want hidden Windows process attributes")
	}
	if got := cmd.SysProcAttr.CreationFlags; got&windows.CREATE_NO_WINDOW == 0 {
		t.Fatalf("CreationFlags = %#x, want CREATE_NO_WINDOW", got)
	}
	if !cmd.SysProcAttr.HideWindow {
		t.Fatal("HideWindow = false, want true")
	}
}

func TestCommandContextRunsWindowsBatchShim(t *testing.T) {
	dir := t.TempDir()
	shim := filepath.Join(dir, "greptile helper.cmd")
	if err := os.WriteFile(shim, []byte("@echo off\r\necho %~1\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	output, err := CommandContext(context.Background(), shim, "argument with spaces").CombinedOutput()
	if err != nil {
		t.Fatalf("run batch shim: %v\n%s", err, output)
	}
	if got := strings.TrimSpace(string(output)); got != "argument with spaces" {
		t.Fatalf("output = %q, want batch argument preserved", got)
	}
}

func TestAttachedCommandContextPreservesTerminalForWindowsBatchShim(t *testing.T) {
	dir := t.TempDir()
	shim := filepath.Join(dir, "greptile helper.cmd")
	if err := os.WriteFile(shim, []byte("@echo off\r\necho attached\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	cmd := AttachedCommandContext(context.Background(), shim)
	if cmd.SysProcAttr == nil {
		t.Fatal("SysProcAttr = nil, want batch-shim command line configuration")
	}
	if got := cmd.SysProcAttr.CreationFlags; got&windows.CREATE_NO_WINDOW != 0 {
		t.Fatalf("CreationFlags = %#x, must not include CREATE_NO_WINDOW", got)
	}
	if cmd.SysProcAttr.HideWindow {
		t.Fatal("HideWindow = true, want terminal-attached child")
	}
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("run attached batch shim: %v\n%s", err, output)
	}
	if got := strings.TrimSpace(string(output)); got != "attached" {
		t.Fatalf("output = %q, want attached", got)
	}
}
