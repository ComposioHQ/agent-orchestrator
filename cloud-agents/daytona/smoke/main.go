package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/daytona/clients/sdk-go/pkg/daytona"
	sdkoptions "github.com/daytona/clients/sdk-go/pkg/options"
	"github.com/daytona/clients/sdk-go/pkg/types"
)

const (
	repositoryURL = "https://github.com/AgentWrapper/agent-orchestrator.git"
	workspacePath = "/workspace/agent-orchestrator"
	loginTimeout  = 10 * time.Minute
)

type config struct {
	name          string
	dockerfile    string
	reuse         bool
	createTimeout time.Duration
}

type runner struct {
	cfg     config
	client  *daytona.Client
	sandbox *daytona.Sandbox
}

func main() {
	cfg := parseFlags()
	if strings.TrimSpace(os.Getenv("DAYTONA_API_KEY")) == "" {
		fmt.Fprintln(os.Stderr, "DAYTONA_API_KEY is not set")
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	client, err := daytona.NewClient()
	if err != nil {
		fmt.Fprintln(os.Stderr, "create Daytona client:", err)
		os.Exit(1)
	}

	r := &runner{cfg: cfg, client: client}
	if err := r.run(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "smoke setup failed:", err)
		os.Exit(1)
	}
}

func parseFlags() config {
	var cfg config
	flag.StringVar(&cfg.name, "name", "ao-smoke", "Daytona sandbox name")
	flag.StringVar(&cfg.dockerfile, "dockerfile", "", "path to the Daytona Dockerfile (auto-detected by default)")
	flag.BoolVar(&cfg.reuse, "reuse", false, "reuse the named sandbox")
	flag.DurationVar(&cfg.createTimeout, "create-timeout", 30*time.Minute, "maximum sandbox creation time")
	flag.Parse()
	return cfg
}

func (r *runner) run(ctx context.Context) error {
	sandbox, err := r.getSandbox(ctx)
	if err != nil {
		return err
	}
	r.sandbox = sandbox
	fmt.Printf("Daytona sandbox ready: %s (%s)\n", sandbox.Name, sandbox.ID)

	if _, err := r.exec(ctx, "mkdir -p /root/.ao/data /root/.ao/codex /workspace"); err != nil {
		return err
	}
	if err := r.loginCodex(ctx); err != nil {
		return err
	}
	if err := r.prepareSource(ctx); err != nil {
		return err
	}
	if err := r.startDevelopmentTerminals(ctx); err != nil {
		return err
	}

	fmt.Println("\nAO development environment is running in two sandbox terminals.")
	fmt.Printf("Open two local terminals and run:\n\n  daytona ssh %s\n\n", sandbox.Name)
	fmt.Println("Then attach one terminal to each process:")
	fmt.Println("  tmux attach -t ao-daemon")
	fmt.Println("  tmux attach -t ao-frontend")
	fmt.Println("\nDetach from either tmux terminal with Ctrl+B, then D.")
	return nil
}

func (r *runner) getSandbox(ctx context.Context) (*daytona.Sandbox, error) {
	if r.cfg.reuse {
		sandbox, err := r.client.Get(ctx, r.cfg.name)
		if err != nil {
			return nil, fmt.Errorf("get sandbox %q: %w", r.cfg.name, err)
		}
		if sandbox.State != daytona.SandboxStateStarted {
			if err := sandbox.StartWithTimeout(ctx, 10*time.Minute); err != nil {
				return nil, fmt.Errorf("start sandbox: %w", err)
			}
		}
		return sandbox, nil
	}

	path, err := resolveDockerfile(r.cfg.dockerfile)
	if err != nil {
		return nil, err
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read Dockerfile: %w", err)
	}

	fmt.Printf("Building %s and creating sandbox %q...\n", path, r.cfg.name)
	logs := make(chan string, 128)
	done := make(chan struct{})
	go func() {
		for {
			select {
			case line := <-logs:
				fmt.Println("[image]", line)
			case <-done:
				return
			}
		}
	}()

	zero := 0
	sandbox, err := r.client.Create(ctx, types.ImageParams{
		SandboxBaseParams: types.SandboxBaseParams{
			Name:              r.cfg.name,
			AutoStopInterval:  &zero,
			AutoPauseInterval: &zero,
		},
		Image: daytona.FromDockerfile(string(contents)),
		Resources: &types.Resources{
			CPU:    4,
			Memory: 8,
			Disk:   10,
		},
	}, sdkoptions.WithTimeout(r.cfg.createTimeout), sdkoptions.WithLogChannel(logs))
	close(done)
	if err != nil {
		return nil, fmt.Errorf("create sandbox: %w", err)
	}
	return sandbox, nil
}

func (r *runner) loginCodex(ctx context.Context) error {
	if r.codexLoggedIn(ctx) {
		fmt.Println("Codex is already logged in.")
		return nil
	}

	fmt.Println("Starting Codex device authentication.")
	fmt.Println("Open the URL printed below on your laptop and approve the code.")

	loginCtx, cancel := context.WithTimeout(ctx, loginTimeout)
	defer cancel()
	handle, err := r.sandbox.Process.CreatePty(loginCtx, fmt.Sprintf("codex-login-%d", time.Now().UnixNano()),
		sdkoptions.WithCreatePtySize(types.PtySize{Rows: 30, Cols: 120}),
		sdkoptions.WithCreatePtyEnv(map[string]string{
			"TERM":       "xterm-256color",
			"HOME":       "/root",
			"CODEX_HOME": "/root/.ao/codex",
		}),
	)
	if err != nil {
		return fmt.Errorf("create login terminal: %w", err)
	}
	defer func() {
		_ = handle.Disconnect()
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		_ = handle.Kill(cleanupCtx)
	}()
	if err := handle.WaitForConnection(loginCtx); err != nil {
		return err
	}

	go copyOutput(os.Stdout, handle.DataChan())
	if err := handle.SendInput([]byte("codex login --device-auth\n")); err != nil {
		return err
	}

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-loginCtx.Done():
			return fmt.Errorf("wait for Codex login: %w", loginCtx.Err())
		case <-ticker.C:
			if r.codexLoggedIn(loginCtx) {
				fmt.Println("\nCodex login complete.")
				return nil
			}
		}
	}
}

func (r *runner) codexLoggedIn(ctx context.Context) bool {
	response, err := r.sandbox.Process.ExecuteCommand(ctx, "codex login status")
	if err != nil || response.ExitCode != 0 {
		return false
	}
	result := strings.ToLower(response.Result)
	return strings.Contains(result, "logged in") && !strings.Contains(result, "not logged in")
}

func (r *runner) prepareSource(ctx context.Context) error {
	fmt.Println("Preparing the original AO source repository...")
	command := fmt.Sprintf(
		`if [ ! -d %[1]s/.git ]; then git clone --depth 1 %[2]s %[1]s; fi && git config --global --add safe.directory %[1]s && if [ ! -d %[1]s/frontend/node_modules ]; then cd %[1]s/frontend && npm ci; fi`,
		shellQuote(workspacePath), shellQuote(repositoryURL),
	)
	if _, err := r.exec(ctx, command); err != nil {
		return fmt.Errorf("prepare AO source: %w", err)
	}
	return nil
}

func (r *runner) startDevelopmentTerminals(ctx context.Context) error {
	fmt.Println("Starting ao daemon and the frontend in separate tmux terminals...")
	backend := fmt.Sprintf(
		`tmux has-session -t ao-daemon 2>/dev/null || tmux new-session -d -s ao-daemon -c %s %s`,
		shellQuote(filepath.ToSlash(filepath.Join(workspacePath, "backend"))),
		shellQuote(`ao daemon; code=$?; echo "ao daemon exited with $code"; exec bash`),
	)
	if _, err := r.exec(ctx, backend); err != nil {
		return fmt.Errorf("start AO daemon terminal: %w", err)
	}

	frontend := fmt.Sprintf(
		`tmux has-session -t ao-frontend 2>/dev/null || tmux new-session -d -s ao-frontend -c %s %s`,
		shellQuote(filepath.ToSlash(filepath.Join(workspacePath, "frontend"))),
		shellQuote(`AO_PORT=3001 AO_DATA_DIR=/root/.ao/data npm run dev; code=$?; echo "npm run dev exited with $code"; exec bash`),
	)
	if _, err := r.exec(ctx, frontend); err != nil {
		return fmt.Errorf("start frontend terminal: %w", err)
	}

	readyCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	for {
		response, err := r.sandbox.Process.ExecuteCommand(readyCtx, "curl -fsS http://127.0.0.1:3001/readyz")
		if err == nil && response.ExitCode == 0 {
			return nil
		}
		select {
		case <-readyCtx.Done():
			output, _ := r.sandbox.Process.ExecuteCommand(context.Background(), "tmux capture-pane -p -S -100 -t ao-daemon")
			return fmt.Errorf("AO daemon did not become ready: %w\n%s", readyCtx.Err(), output.Result)
		case <-time.After(time.Second):
		}
	}
}

func (r *runner) exec(ctx context.Context, command string) (string, error) {
	response, err := r.sandbox.Process.ExecuteCommand(ctx, command)
	if err != nil {
		return "", err
	}
	if response.ExitCode != 0 {
		return "", fmt.Errorf("command exited %d: %s", response.ExitCode, strings.TrimSpace(response.Result))
	}
	return response.Result, nil
}

func resolveDockerfile(explicit string) (string, error) {
	if explicit != "" {
		path, err := filepath.Abs(explicit)
		if err != nil {
			return "", err
		}
		if _, err := os.Stat(path); err != nil {
			return "", err
		}
		return path, nil
	}

	for _, candidate := range []string{
		filepath.Join("..", "Dockerfile"),
		filepath.Join("cloud-agents", "daytona", "Dockerfile"),
		"Dockerfile",
	} {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return filepath.Abs(candidate)
		}
	}
	return "", errors.New("could not find the Daytona Dockerfile; pass --dockerfile")
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'"
}

func copyOutput(dst io.Writer, source <-chan []byte) {
	for data := range source {
		_, _ = dst.Write(data)
	}
}
