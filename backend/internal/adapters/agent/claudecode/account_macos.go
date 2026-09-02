//go:build darwin

package claudecode

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

const (
	claudeSecurityBinary         = "/usr/bin/security"
	claudeSecurityCommandMaxSize = 4096 - 64
	claudeSecurityTimeout        = 5 * time.Second
)

type claudeSecurityRunner func(context.Context, []string, []byte) ([]byte, int, error)

type macOSClaudeKeychain struct{ run claudeSecurityRunner }

func newMacOSClaudeKeychain() *macOSClaudeKeychain {
	return &macOSClaudeKeychain{run: runClaudeSecurity}
}

// NewKeychain returns the macOS Claude Code credential store.
func NewKeychain() Keychain { return newMacOSClaudeKeychain() }

func (*macOSClaudeKeychain) Supported() bool { return true }

func (s *macOSClaudeKeychain) Get(ctx context.Context, service, account string) ([]byte, bool, error) {
	return s.get(ctx, service, account)
}

func (s *macOSClaudeKeychain) Set(ctx context.Context, service, account string, value []byte) error {
	return s.set(ctx, service, account, value)
}

func (s *macOSClaudeKeychain) Delete(ctx context.Context, service, account string) error {
	return s.delete(ctx, service, account)
}

func runClaudeSecurity(ctx context.Context, args []string, input []byte) ([]byte, int, error) {
	callCtx, cancel := context.WithTimeout(ctx, claudeSecurityTimeout)
	defer cancel()
	cmd := exec.CommandContext(callCtx, claudeSecurityBinary, args...)
	cmd.Stdin = bytes.NewReader(input)
	out, err := cmd.Output()
	if callCtx.Err() != nil {
		return nil, -1, fmt.Errorf("keychain operation timed out for Claude Code: %w", callCtx.Err())
	}
	if err == nil {
		return out, 0, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return nil, exitErr.ExitCode(), nil
	}
	return nil, -1, err
}

func (s *macOSClaudeKeychain) get(ctx context.Context, service, account string) ([]byte, bool, error) {
	out, code, err := s.run(ctx, []string{"find-generic-password", "-a", account, "-w", "-s", service}, nil)
	if err != nil {
		return nil, false, err
	}
	if code == 44 {
		return nil, false, nil
	}
	if code != 0 {
		return nil, false, fmt.Errorf("keychain read failed for Claude Code with status %d", code)
	}
	return bytes.TrimSuffix(out, []byte("\n")), true, nil
}

func (s *macOSClaudeKeychain) set(ctx context.Context, service, account string, value []byte) error {
	command := "add-generic-password -U -a " + quoteSecurityInput(account) + " -s " + quoteSecurityInput(service) + " -X " + hex.EncodeToString(value) + "\n"
	if len(command) > claudeSecurityCommandMaxSize {
		return errors.New("credential is too large for a secret-safe Claude Code Keychain write")
	}
	_, code, err := s.run(ctx, []string{"-i"}, []byte(command))
	if err != nil {
		return err
	}
	if code != 0 {
		return fmt.Errorf("keychain write failed for Claude Code with status %d", code)
	}
	return nil
}

func (s *macOSClaudeKeychain) delete(ctx context.Context, service, account string) error {
	_, code, err := s.run(ctx, []string{"delete-generic-password", "-a", account, "-s", service}, nil)
	if err != nil {
		return err
	}
	if code != 0 && code != 44 {
		return fmt.Errorf("keychain delete failed for Claude Code with status %d", code)
	}
	return nil
}

func quoteSecurityInput(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `"`, `\"`)
	return `"` + replacer.Replace(value) + `"`
}
