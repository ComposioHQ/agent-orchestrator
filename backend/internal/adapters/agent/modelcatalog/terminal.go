package modelcatalog

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/terminalui"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	modelTerminalRows        = 40
	modelTerminalColumns     = 160
	modelMenuSettleDelay     = 200 * time.Millisecond
	modelTerminalOutputLimit = 1 << 20
)

// TerminalSpawnFunc opens a private agent process on a PTY in one project
// scope. It is injected so catalog tests never launch an installed CLI.
type TerminalSpawnFunc func(ctx context.Context, argv, env []string, workingDir string, rows, cols uint16) (ports.Stream, error)

var (
	modelMenuRowPattern = regexp.MustCompile(`^\s*(?:[❯›>]\s*)?(\d+)[.)]\s+(.+?)(?:\s{2,}|\s+[—–-]\s+).+$`)
	museModelIDPattern  = regexp.MustCompile(`^[a-z0-9][a-z0-9._/-]*$`)
)

type modelMenuRow struct {
	number   int
	label    string
	selected bool
}

type terminalRead struct {
	data []byte
	err  error
}

func discoverTerminalCatalog(ctx context.Context, request ports.AgentModelDiscoveryRequest, spawn TerminalSpawnFunc) (ports.AgentModelCatalog, error) {
	base := Base(request.AgentID)
	if spawn == nil {
		return base, errors.New("interactive model discovery is unavailable")
	}
	if strings.TrimSpace(request.Binary) == "" {
		return base, errors.New("agent binary is not installed")
	}
	if request.AgentID != "muse" {
		return base, fmt.Errorf("%s does not support terminal model discovery", request.AgentID)
	}
	args := []string{request.Binary, "--no-session-log"}

	runCtx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	stream, err := spawn(runCtx, args, mergedEnvironment(os.Environ(), request.Env), request.WorkingDir, modelTerminalRows, modelTerminalColumns)
	if err != nil {
		return base, fmt.Errorf("%s model discovery: %w", request.AgentID, err)
	}
	defer func() { _ = stream.Close() }()

	reads := make(chan terminalRead)
	go readTerminal(runCtx, stream, reads)
	var output strings.Builder
	var discovered []ports.AgentModelInfo
	var lastParseErr error
	commandSent := false
	var settle <-chan time.Time
	var settleTimer *time.Timer
	defer func() {
		if settleTimer != nil {
			settleTimer.Stop()
		}
	}()

	for {
		select {
		case <-runCtx.Done():
			return base, modelDiscoveryError(runCtx, request.AgentID, runCtx.Err())
		case <-settle:
			if len(discovered) == 0 {
				settle = nil
				continue
			}
			return terminalCatalog(base, discovered), nil
		case read := <-reads:
			if len(read.data) > 0 {
				if output.Len()+len(read.data) > modelTerminalOutputLimit {
					return base, fmt.Errorf("%s model discovery output exceeded %d bytes", request.AgentID, modelTerminalOutputLimit)
				}
				_, _ = output.Write(read.data)
				visible := output.String()
				if unsafeModelDiscoveryScreen(visible) {
					return base, errors.New("agent requires trust or authentication before model discovery")
				}
				if !commandSent && terminalComposerReady(request.AgentID, visible) {
					if err := writeTerminalCommand(stream, "/model\r"); err != nil {
						return base, fmt.Errorf("%s model discovery command: %w", request.AgentID, err)
					}
					commandSent = true
				}
				if commandSent {
					candidate, parseErr := parseTerminalModels(request.AgentID, visible)
					if parseErr != nil {
						if len(discovered) == 0 {
							lastParseErr = parseErr
						}
					} else {
						lastParseErr = nil
						if len(candidate) >= len(discovered) {
							discovered = candidate
						}
					}
					if len(discovered) > 0 {
						if settleTimer == nil {
							settleTimer = time.NewTimer(modelMenuSettleDelay)
						} else {
							if !settleTimer.Stop() {
								select {
								case <-settleTimer.C:
								default:
								}
							}
							settleTimer.Reset(modelMenuSettleDelay)
						}
						settle = settleTimer.C
					}
				}
			}
			if read.err != nil {
				if errors.Is(read.err, io.EOF) && len(discovered) > 0 {
					return terminalCatalog(base, discovered), nil
				}
				if lastParseErr != nil {
					return base, fmt.Errorf("%s model discovery: %w", request.AgentID, lastParseErr)
				}
				return base, fmt.Errorf("%s model discovery terminal closed: %w", request.AgentID, read.err)
			}
		}
	}
}

func readTerminal(ctx context.Context, stream ports.Stream, reads chan<- terminalRead) {
	buffer := make([]byte, 4096)
	for {
		n, err := stream.Read(buffer)
		result := terminalRead{err: err}
		if n > 0 {
			result.data = append([]byte(nil), buffer[:n]...)
		}
		select {
		case reads <- result:
		case <-ctx.Done():
			return
		}
		if err != nil {
			return
		}
	}
}

func writeTerminalCommand(stream ports.Stream, command string) error {
	remaining := []byte(command)
	for len(remaining) > 0 {
		n, err := stream.Write(remaining)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		remaining = remaining[n:]
	}
	return nil
}

func terminalComposerReady(agentID, output string) bool {
	switch agentID {
	case "muse":
		lines := terminalui.PlainTerminalLines(output)
		hasComposer := false
		hasFooter := false
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if line == "⟩" {
				hasComposer = true
			}
			if strings.Contains(line, " · ") && strings.Contains(strings.ToLower(line), "muse-") {
				hasFooter = true
			}
		}
		return hasComposer && hasFooter
	default:
		return false
	}
}

func parseTerminalModels(agentID, output string) ([]ports.AgentModelInfo, error) {
	switch agentID {
	case "muse":
		return parseMuseModelMenu(output)
	default:
		return nil, errors.New("unsupported terminal model catalog")
	}
}

func terminalCatalog(base ports.AgentModelCatalog, models []ports.AgentModelInfo) ports.AgentModelCatalog {
	base.Models = normalize(models)
	base.Source = "cli"
	base.FetchedAt = time.Now().UTC()
	return base
}

func applyClaudeConfiguredDefault(models []ports.AgentModelInfo, workingDir string, env map[string]string) []ports.AgentModelInfo {
	configured := claudeCodeResolvedModel(workingDir, env)
	if configured == "" {
		return models
	}
	for i := range models {
		models[i].IsDefault = strings.EqualFold(models[i].ID, configured)
	}
	return models
}

func parseMuseModelMenu(output string) ([]ports.AgentModelInfo, error) {
	rows, err := parseNumberedModelMenu(output)
	if err != nil {
		return nil, err
	}
	models := make([]ports.AgentModelInfo, 0, len(rows))
	seen := make(map[string]struct{}, len(rows))
	for _, row := range rows {
		id := strings.TrimSpace(strings.TrimSuffix(row.label, "✓"))
		if strings.EqualFold(id, "default") {
			continue
		}
		if id != strings.ToLower(id) || !museModelIDPattern.MatchString(id) {
			return nil, fmt.Errorf("muse model menu option %q is not an explicit model ID", id)
		}
		if _, duplicate := seen[id]; duplicate {
			return nil, fmt.Errorf("muse model menu contains duplicate model ID %q", id)
		}
		seen[id] = struct{}{}
		models = append(models, ports.AgentModelInfo{ID: id, Label: id, IsDefault: row.selected})
	}
	if len(models) == 0 {
		return nil, errors.New("muse model menu returned no models")
	}
	return models, nil
}

func parseNumberedModelMenu(output string) ([]modelMenuRow, error) {
	plain := terminalui.PlainTerminalText(output)
	if unsafeModelDiscoveryScreen(plain) {
		return nil, errors.New("agent requires trust or authentication before model discovery")
	}
	plain = latestNumberedModelMenuText(plain)
	rows := make([]modelMenuRow, 0, 8)
	for _, line := range strings.Split(plain, "\n") {
		matches := modelMenuRowPattern.FindStringSubmatch(line)
		if len(matches) != 3 {
			continue
		}
		number, err := strconv.Atoi(matches[1])
		if err != nil {
			return nil, errors.New("model menu contains an invalid option number")
		}
		label := strings.TrimSpace(matches[2])
		selected := strings.HasSuffix(label, "✓") || strings.HasPrefix(strings.ToLower(label), "(selected)")
		label = strings.TrimSpace(strings.TrimPrefix(label, "(selected)"))
		rows = append(rows, modelMenuRow{number: number, label: label, selected: selected})
	}
	if len(rows) < 2 || rows[0].number != 1 {
		return nil, errors.New("model menu is incomplete")
	}
	for i, row := range rows {
		if row.number != i+1 {
			return nil, errors.New("model menu numbering is incomplete")
		}
	}
	return rows, nil
}

func latestNumberedModelMenuText(output string) string {
	plain := terminalui.PlainTerminalText(output)
	lines := strings.Split(plain, "\n")
	start := -1
	for i, line := range lines {
		matches := modelMenuRowPattern.FindStringSubmatch(line)
		if len(matches) == 3 && matches[1] == "1" {
			start = i
		}
	}
	if start < 0 {
		return plain
	}
	return strings.Join(lines[start:], "\n")
}

func unsafeModelDiscoveryScreen(output string) bool {
	lower := strings.ToLower(output)
	return strings.Contains(lower, "do you trust") ||
		strings.Contains(lower, "trust this folder") ||
		strings.Contains(lower, "authentication required") ||
		strings.Contains(lower, "sign in to continue") ||
		strings.Contains(lower, "login to continue")
}
