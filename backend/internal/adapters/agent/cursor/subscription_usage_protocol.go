package cursor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

const maxCursorUsageOutput = 64 << 10

var (
	errCursorUsageBuildUnsupported = errors.New("cursor build does not expose a verified usage protocol")
	supportedCursorUsageBuilds     = map[string]struct{}{
		"2026.08.11-e8db854": {},
		"2026.08.25-3e8eec8": {},
	}
)

type cursorUsageClient interface {
	ReadUsage(context.Context) (rawCursorUsage, error)
}

type rawCursorUsage struct {
	PlanName   string
	ResetLabel string
	Included   *rawIncludedUsage
	OnDemand   *rawOnDemandUsage
}

type rawIncludedUsage struct {
	TotalPercentUsed *float64 `json:"totalPercentUsed"`
	AutoPercentUsed  *float64 `json:"autoPercentUsed"`
	APIPercentUsed   *float64 `json:"apiPercentUsed"`
}

type rawOnDemandUsage struct {
	Kind         string   `json:"kind"`
	UsedDollars  *float64 `json:"usedDollars"`
	LimitDollars *float64 `json:"limitDollars"`
}

type usageCommandRunner func(context.Context, string, string, string) ([]byte, error)

type privateCursorUsageClient struct {
	binaryPath string
	build      string
	runtimeDir string
	run        usageCommandRunner
}

func newCursorUsageClient(binaryPath, build, runtimeDir string, runner usageCommandRunner) (cursorUsageClient, error) {
	build = strings.TrimSpace(build)
	if _, ok := supportedCursorUsageBuilds[build]; !ok {
		return nil, fmt.Errorf("%w: %s", errCursorUsageBuildUnsupported, build)
	}
	if runner == nil {
		runner = runCursorUsageHelper
	}
	return &privateCursorUsageClient{binaryPath: binaryPath, build: build, runtimeDir: runtimeDir, run: runner}, nil
}

func (c *privateCursorUsageClient) ReadUsage(ctx context.Context) (rawCursorUsage, error) {
	out, err := c.run(ctx, c.binaryPath, c.build, c.runtimeDir)
	if err != nil {
		return rawCursorUsage{}, fmt.Errorf("cursor usage helper failed: %w", err)
	}
	if len(out) > maxCursorUsageOutput {
		return rawCursorUsage{}, errors.New("cursor usage helper returned oversized output")
	}
	var envelope struct {
		CLIVersion string `json:"cliVersion"`
		Usage      *struct {
			Kind  string `json:"kind"`
			Model *struct {
				Kind       string            `json:"kind"`
				PlanName   string            `json:"planName"`
				ResetLabel string            `json:"resetLabel"`
				Included   *rawIncludedUsage `json:"included"`
				OnDemand   *rawOnDemandUsage `json:"onDemand"`
			} `json:"model"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(out, &envelope); err != nil {
		return rawCursorUsage{}, fmt.Errorf("decode Cursor usage helper output: %w", err)
	}
	if envelope.CLIVersion != c.build {
		return rawCursorUsage{}, errors.New("cursor usage helper build identity changed")
	}
	if envelope.Usage == nil || envelope.Usage.Kind != "available" || envelope.Usage.Model == nil || envelope.Usage.Model.Kind != "standard" {
		return rawCursorUsage{}, errors.New("cursor usage is unavailable for this account")
	}
	raw := rawCursorUsage{
		PlanName: envelope.Usage.Model.PlanName, ResetLabel: envelope.Usage.Model.ResetLabel,
		Included: envelope.Usage.Model.Included, OnDemand: envelope.Usage.Model.OnDemand,
	}
	if err := validateRawCursorUsage(raw); err != nil {
		return rawCursorUsage{}, err
	}
	return raw, nil
}

func validateRawCursorUsage(raw rawCursorUsage) error {
	reported := false
	if raw.Included != nil {
		for _, value := range []*float64{raw.Included.TotalPercentUsed, raw.Included.AutoPercentUsed, raw.Included.APIPercentUsed} {
			if value == nil {
				continue
			}
			if math.IsNaN(*value) || math.IsInf(*value, 0) {
				return errors.New("cursor usage contains a non-finite percentage")
			}
			reported = true
		}
	}
	if raw.OnDemand != nil {
		if raw.OnDemand.Kind == "" {
			return errors.New("cursor on-demand usage has no state")
		}
		for _, value := range []*float64{raw.OnDemand.UsedDollars, raw.OnDemand.LimitDollars} {
			if value != nil && (math.IsNaN(*value) || math.IsInf(*value, 0)) {
				return errors.New("cursor usage contains a non-finite spend value")
			}
		}
		if raw.OnDemand.Kind == "fixed" && (raw.OnDemand.UsedDollars == nil || raw.OnDemand.LimitDollars == nil) {
			return errors.New("cursor fixed on-demand usage is incomplete")
		}
		reported = true
	}
	if !reported {
		return errors.New("cursor usage helper returned no capacity categories")
	}
	return nil
}

func runCursorUsageHelper(ctx context.Context, binaryPath, build, runtimeDir string) ([]byte, error) {
	resolved, err := filepath.EvalSymlinks(binaryPath)
	if err != nil {
		return nil, fmt.Errorf("resolve Cursor executable: %w", err)
	}
	cursorDir := filepath.Dir(resolved)
	node := filepath.Join(cursorDir, "node")
	if runtime.GOOS == "windows" {
		node = filepath.Join(cursorDir, "node.exe")
	}
	helper := filepath.Join(runtimeDir, "ao-cursor-subscription-usage.cjs")
	for path, label := range map[string]string{node: "Cursor Node runtime", helper: "AO Cursor usage helper"} {
		info, statErr := os.Stat(path)
		if statErr != nil || info.IsDir() {
			return nil, fmt.Errorf("%s is unavailable", label)
		}
	}
	cmd := aoprocess.CommandContext(ctx, node, helper, cursorDir, build) //nolint:gosec // fixed AO helper and resolved Cursor runtime.
	cmd.Env = cursorUsageHelperEnv(os.Environ())
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, errors.New("could not capture helper output")
	}
	if err := cmd.Start(); err != nil {
		return nil, errors.New("could not execute helper")
	}
	out, readErr := io.ReadAll(io.LimitReader(stdout, maxCursorUsageOutput+1))
	if len(out) > maxCursorUsageOutput {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, errors.New("cursor usage helper returned oversized output")
	}
	err = cmd.Wait()
	if readErr != nil {
		return nil, errors.New("could not read helper output")
	}
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, ctx.Err()
		}
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return nil, fmt.Errorf("helper exited with status %d", exitErr.ExitCode())
		}
		return nil, errors.New("could not execute helper")
	}
	return out, nil
}

func cursorUsageHelperEnv(source []string) []string {
	allowed := map[string]bool{
		"HOME": true, "USER": true, "LOGNAME": true, "PATH": true, "TMPDIR": true,
		"XDG_CONFIG_HOME": true, "XDG_DATA_HOME": true, "XDG_CACHE_HOME": true,
		"APPDATA": true, "LOCALAPPDATA": true, "USERPROFILE": true, "SYSTEMROOT": true, "WINDIR": true,
		"LANG": true, "LC_ALL": true, "LC_CTYPE": true, "SHELL": true, cursorDataDirEnv: true,
	}
	out := make([]string, 0, len(allowed))
	for _, entry := range source {
		key, _, ok := strings.Cut(entry, "=")
		if ok && allowed[strings.ToUpper(key)] {
			out = append(out, entry)
		}
	}
	return out
}

func readCursorBuild(ctx context.Context, binary string) (string, error) {
	if resolved, err := filepath.EvalSymlinks(binary); err == nil {
		if build := filepath.Base(filepath.Dir(resolved)); strings.HasPrefix(build, "20") && strings.Contains(build, "-") {
			return build, nil
		}
	}
	out, err := aoprocess.CommandContext(ctx, binary, "--version").Output()
	if err != nil {
		return "", errors.New("could not read Cursor version")
	}
	return strings.TrimSpace(string(out)), nil
}
