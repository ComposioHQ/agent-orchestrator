package claudeacp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

const (
	modelDiscoveryTimeout     = 20 * time.Second
	modelDiscoveryOutputLimit = 1 << 20
)

type modelDiscoveryRunner struct {
	resolve func(context.Context) (runtimeLaunch, error)
	run     func(context.Context, runtimeLaunch, ports.AgentModelDiscoveryRequest) ([]byte, error)
}

// DiscoverModels reads Claude Code's account-scoped model catalog through the
// non-interactive Agent SDK control channel. It never sends a prompt.
func DiscoverModels(ctx context.Context, request ports.AgentModelDiscoveryRequest) ([]ports.AgentModelInfo, error) {
	runCtx, cancel := context.WithTimeout(ctx, modelDiscoveryTimeout)
	defer cancel()
	return (modelDiscoveryRunner{}).discover(runCtx, request)
}

func (r modelDiscoveryRunner) discover(ctx context.Context, request ports.AgentModelDiscoveryRequest) ([]ports.AgentModelInfo, error) {
	resolve := r.resolve
	if resolve == nil {
		resolve = resolveModelRuntime
	}
	run := r.run
	if run == nil {
		run = runModelDiscovery
	}
	launch, err := resolve(ctx)
	if err != nil {
		return nil, fmt.Errorf("resolve Claude model SDK runtime: %w", err)
	}
	output, err := run(ctx, launch, request)
	if err != nil {
		return nil, fmt.Errorf("run Claude model SDK: %w", err)
	}
	var response struct {
		Version int `json:"version"`
		Models  []struct {
			Value       string `json:"value"`
			DisplayName string `json:"displayName"`
		} `json:"models"`
	}
	if err := json.Unmarshal(output, &response); err != nil {
		return nil, fmt.Errorf("parse Claude model SDK response: %w", err)
	}
	if response.Version != 1 {
		return nil, fmt.Errorf("unsupported Claude model SDK response version %d", response.Version)
	}
	models := make([]ports.AgentModelInfo, 0, len(response.Models))
	for _, entry := range response.Models {
		id := strings.TrimSpace(entry.Value)
		if id == "" {
			continue
		}
		label := strings.TrimSpace(entry.DisplayName)
		if label == "" {
			label = id
		}
		models = append(models, ports.AgentModelInfo{ID: id, Label: label})
	}
	if len(models) == 0 {
		return nil, errors.New("claude model SDK returned no models")
	}
	return models, nil
}

func resolveModelRuntime(ctx context.Context) (runtimeLaunch, error) {
	if command := strings.TrimSpace(os.Getenv("AO_CLAUDE_MODEL_CATALOG_COMMAND")); command != "" {
		resolved, err := exec.LookPath(command)
		if err != nil {
			return runtimeLaunch{}, fmt.Errorf("resolve AO_CLAUDE_MODEL_CATALOG_COMMAND %q: %w", command, err)
		}
		return runtimeLaunch{command: resolved}, nil
	}
	runtimeDir := strings.TrimSpace(os.Getenv("AO_ACP_RUNTIME_DIR"))
	if runtimeDir == "" {
		runtimeDir = runtimeDirectoryBesideExecutable()
	}
	if runtimeDir == "" {
		return runtimeLaunch{}, errors.New("AO ACP runtime is not installed")
	}
	node := filepath.Join(runtimeDir, "node", "bin", "node")
	if runtime.GOOS == "windows" {
		node = filepath.Join(runtimeDir, "node", "node.exe")
	}
	entry := filepath.Join(runtimeDir, "claude-model-catalog.mjs")
	if err := requireFile(node, "packaged Node runtime"); err != nil {
		return runtimeLaunch{}, err
	}
	if err := requireFile(entry, "Claude model catalog entrypoint"); err != nil {
		return runtimeLaunch{}, err
	}
	if err := requireNodeVersion(ctx, node); err != nil {
		return runtimeLaunch{}, err
	}
	return runtimeLaunch{command: node, args: []string{entry}}, nil
}

func runModelDiscovery(ctx context.Context, launch runtimeLaunch, request ports.AgentModelDiscoveryRequest) ([]byte, error) {
	cmd := aoprocess.CommandContext(ctx, launch.command, launch.args...) //nolint:gosec // resolved packaged runtime and static entrypoint
	cmd.WaitDelay = 2 * time.Second
	if strings.TrimSpace(request.WorkingDir) != "" {
		cmd.Dir = request.WorkingDir
	}
	overrides := make(map[string]string, len(request.Env)+1)
	for key, value := range request.Env {
		overrides[key] = value
	}
	overrides["CLAUDE_CODE_EXECUTABLE"] = request.Binary
	cmd.Env = mergeModelEnvironment(os.Environ(), overrides)
	var stdout limitedModelBuffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if errors.Is(stdout.err, errModelDiscoveryOutputTooLarge) {
			return nil, errModelDiscoveryOutputTooLarge
		}
		message := strings.TrimSpace(stderr.String())
		if message != "" {
			return nil, fmt.Errorf("%w: %s", err, message)
		}
		return nil, err
	}
	return stdout.Bytes(), nil
}

var errModelDiscoveryOutputTooLarge = fmt.Errorf("claude model SDK output exceeded %d bytes", modelDiscoveryOutputLimit)

type limitedModelBuffer struct {
	bytes.Buffer
	err error
}

func (b *limitedModelBuffer) Write(data []byte) (int, error) {
	if b.Len()+len(data) > modelDiscoveryOutputLimit {
		b.err = errModelDiscoveryOutputTooLarge
		return 0, b.err
	}
	return b.Buffer.Write(data)
}

func mergeModelEnvironment(base []string, overrides map[string]string) []string {
	keys := make([]string, 0, len(overrides))
	for key := range overrides {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(base)+len(keys))
	for _, item := range base {
		key, _, _ := strings.Cut(item, "=")
		if _, replaced := overrides[key]; !replaced {
			out = append(out, item)
		}
	}
	for _, key := range keys {
		out = append(out, key+"="+overrides[key])
	}
	return out
}
