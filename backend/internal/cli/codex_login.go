package cli

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/charmbracelet/x/term"
	"github.com/spf13/cobra"
)

const codexFileStoreOverride = `cli_auth_credentials_store="file"`

const openAIValidationEndpoint = "https://api.openai.com/v1/models"

func newCodexLoginCommand(ctx *commandContext) *cobra.Command {
	return &cobra.Command{
		Use:    "codex-login",
		Short:  "Sign a managed Codex profile in (internal)",
		Hidden: true,
		Args:   noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return ctx.runCodexLogin(cmd.Context(), cmd.InOrStdin(), cmd.OutOrStdout(), cmd.ErrOrStderr())
		},
	}
}

func (c *commandContext) runCodexLogin(ctx context.Context, in io.Reader, out, stderr io.Writer) error {
	codex, err := c.deps.LookPath("codex")
	if err != nil {
		return fmt.Errorf("codex CLI is not installed or is not available on PATH")
	}
	if _, err := fmt.Fprintln(out, "Sign in to this Codex profile:"); err != nil {
		return err
	}
	for _, line := range []string{
		"  1. ChatGPT in browser",
		"  2. Device code",
		"  3. OpenAI API key",
		"  4. Access token",
	} {
		if _, err := fmt.Fprintln(out, line); err != nil {
			return err
		}
	}
	if _, err := fmt.Fprint(out, "Choose a method [1-4]: "); err != nil {
		return err
	}
	selection, err := readCodexLoginSelection(in)
	if err != nil && !errors.Is(err, io.EOF) {
		return fmt.Errorf("read login method: %w", err)
	}

	args := []string{"-c", codexFileStoreOverride, "login"}
	childInput := in
	switch strings.TrimSpace(selection) {
	case "1":
	case "2":
		args = append(args, "--device-auth")
	case "3", "4":
		flag, label := "--with-api-key", "API key"
		if strings.TrimSpace(selection) == "4" {
			flag, label = "--with-access-token", "access token"
		}
		if _, err := fmt.Fprintf(out, "Enter %s (input hidden): ", label); err != nil {
			return err
		}
		secret, err := c.deps.ReadSecret(in)
		if _, writeErr := fmt.Fprintln(out); writeErr != nil {
			return writeErr
		}
		if err != nil {
			return fmt.Errorf("read %s: %w", label, err)
		}
		secret = bytes.TrimSpace(secret)
		if len(secret) == 0 {
			return fmt.Errorf("%s is required", label)
		}
		defer zeroBytes(secret)
		if strings.TrimSpace(selection) == "3" {
			if _, err := fmt.Fprintln(out, "Verifying API key with OpenAI..."); err != nil {
				return err
			}
			if err := c.deps.ValidateOpenAIAPIKey(ctx, secret); err != nil {
				return err
			}
		}
		args = append(args, flag)
		payload := append(append([]byte(nil), secret...), '\n')
		defer zeroBytes(payload)
		childInput = bytes.NewReader(payload)
	default:
		return usageError{fmt.Errorf("login method must be 1, 2, 3, or 4")}
	}

	if err := c.deps.RunInteractiveCommand(ctx, codex, args, childInput, out, stderr); err != nil {
		return fmt.Errorf("codex login failed: %w", err)
	}
	return nil
}

func zeroBytes(value []byte) {
	for i := range value {
		value[i] = 0
	}
}

func validateOpenAIAPIKey(ctx context.Context, key []byte) error {
	client := &http.Client{Timeout: 10 * time.Second}
	return validateOpenAIAPIKeyAt(ctx, client, openAIValidationEndpoint, key)
}

func validateOpenAIAPIKeyAt(ctx context.Context, client *http.Client, endpoint string, key []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, http.NoBody)
	if err != nil {
		return fmt.Errorf("verify OpenAI API key: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+string(key))
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("OpenAI API key could not be verified; it was not saved: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.CopyN(io.Discard, resp.Body, 4<<10)
	if resp.StatusCode >= http.StatusOK && resp.StatusCode < http.StatusMultipleChoices {
		return nil
	}
	if resp.StatusCode == http.StatusUnauthorized {
		return fmt.Errorf("OpenAI rejected this API key; check the key and try again")
	}
	return fmt.Errorf("OpenAI API key could not be verified (HTTP %d); it was not saved", resp.StatusCode)
}

func readCodexLoginSelection(in io.Reader) (string, error) {
	var value strings.Builder
	var one [1]byte
	for {
		n, err := in.Read(one[:])
		if n == 1 {
			value.WriteByte(one[0])
			if one[0] == '\n' {
				return value.String(), nil
			}
		}
		if err != nil {
			if err == io.EOF && value.Len() > 0 {
				return value.String(), nil
			}
			return "", err
		}
	}
}

func runInteractiveCommand(ctx context.Context, name string, args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	cmd := exec.CommandContext(ctx, name, args...) //nolint:gosec // executable and argv are resolved and fixed by the internal command.
	cmd.Stdin = stdin
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	return cmd.Run()
}

func readSecret(in io.Reader) ([]byte, error) {
	if file, ok := in.(*os.File); ok && term.IsTerminal(file.Fd()) {
		return term.ReadPassword(file.Fd())
	}
	value, err := bufio.NewReader(in).ReadString('\n')
	if err != nil && err != io.EOF {
		return nil, err
	}
	return []byte(value), nil
}
