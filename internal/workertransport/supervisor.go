package workertransport

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/worker"
)

type Control interface {
	ClaimTransport(context.Context) (*worker.TransportRequest, error)
	CompleteTransport(context.Context, string, int, any) error
	FailTransport(context.Context, string, int, string, string) error
	PublishTerminalOutput(context.Context, string, []byte) error
}

type Supervisor struct {
	Control      Control
	Workspace    string
	Shell        string
	PollInterval time.Duration
	Logger       *slog.Logger

	mu        sync.Mutex
	terminals map[string]*terminalProcess
}

type terminalProcess struct {
	cancel context.CancelFunc
	input  io.WriteCloser
}

func (s *Supervisor) Run(ctx context.Context) error {
	if s.Control == nil {
		return errors.New("worker transport control is required")
	}
	if s.Workspace == "" {
		return errors.New("worker transport workspace is required")
	}
	if s.PollInterval <= 0 {
		s.PollInterval = 100 * time.Millisecond
	}
	if s.Shell == "" {
		s.Shell = "/bin/sh"
	}
	if s.Logger == nil {
		s.Logger = slog.Default()
	}
	s.terminals = make(map[string]*terminalProcess)
	workspace, err := openWorkspace(s.Workspace)
	if err != nil {
		return err
	}
	defer workspace.Close()
	defer s.closeAllTerminals()

	ticker := time.NewTicker(s.PollInterval)
	defer ticker.Stop()
	for {
		request, err := s.Control.ClaimTransport(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			s.Logger.Warn("claim worker transport request", "error", err)
		} else if request != nil {
			s.handle(ctx, workspace, request)
			continue
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

func (s *Supervisor) handle(
	ctx context.Context,
	workspace *workspace,
	request *worker.TransportRequest,
) {
	var response any
	var err error
	switch request.Kind {
	case "workspace.list":
		var input worker.WorkspaceListRequest
		err = decodePayload(request.Payload, &input)
		if err == nil {
			response, err = workspace.List(input)
		}
	case "workspace.read":
		var input worker.WorkspaceReadRequest
		err = decodePayload(request.Payload, &input)
		if err == nil {
			response, err = workspace.Read(input)
		}
	case "workspace.write":
		var input worker.WorkspaceWriteRequest
		err = decodePayload(request.Payload, &input)
		if err == nil {
			response, err = workspace.Write(input)
		}
	case "workspace.diff":
		response, err = workspace.Diff(ctx)
	case "terminal.open":
		var input worker.TerminalCommand
		err = decodePayload(request.Payload, &input)
		if err == nil {
			err = s.openTerminal(ctx, input)
			response = map[string]bool{"open": err == nil}
		}
	case "terminal.input":
		var input worker.TerminalCommand
		err = decodePayload(request.Payload, &input)
		if err == nil {
			err = s.writeTerminal(input)
			response = map[string]bool{"accepted": err == nil}
		}
	case "terminal.close":
		var input worker.TerminalCommand
		err = decodePayload(request.Payload, &input)
		if err == nil {
			s.closeTerminal(input.TerminalID)
			response = map[string]bool{"closed": true}
		}
	default:
		err = errors.New("unsupported worker transport request")
	}
	if err == nil {
		if completeErr := s.Control.CompleteTransport(
			ctx, request.ID, request.Attempt, response,
		); completeErr != nil {
			s.Logger.Warn("complete worker transport request", "error", completeErr, "kind", request.Kind)
		}
		return
	}
	code, message := transportError(err)
	if failErr := s.Control.FailTransport(
		ctx, request.ID, request.Attempt, code, message,
	); failErr != nil {
		s.Logger.Warn("fail worker transport request", "error", failErr, "kind", request.Kind)
	}
}

func (s *Supervisor) openTerminal(ctx context.Context, input worker.TerminalCommand) error {
	if input.TerminalID == "" || input.Kind != "workspace" {
		return errors.New("invalid terminal open request")
	}
	s.mu.Lock()
	if _, exists := s.terminals[input.TerminalID]; exists {
		s.mu.Unlock()
		return nil
	}
	processCtx, cancel := context.WithCancel(ctx)
	command := exec.CommandContext(processCtx, s.Shell)
	command.Dir = s.Workspace
	command.Env = append(os.Environ(), "TERM=dumb")
	stdin, err := command.StdinPipe()
	if err != nil {
		cancel()
		s.mu.Unlock()
		return err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		cancel()
		_ = stdin.Close()
		s.mu.Unlock()
		return err
	}
	stderr, err := command.StderrPipe()
	if err != nil {
		cancel()
		_ = stdin.Close()
		s.mu.Unlock()
		return err
	}
	if err := command.Start(); err != nil {
		cancel()
		_ = stdin.Close()
		s.mu.Unlock()
		return err
	}
	s.terminals[input.TerminalID] = &terminalProcess{cancel: cancel, input: stdin}
	s.mu.Unlock()

	go s.copyTerminalOutput(processCtx, input.TerminalID, stdout)
	go s.copyTerminalOutput(processCtx, input.TerminalID, stderr)
	go func() {
		_ = command.Wait()
		s.mu.Lock()
		current := s.terminals[input.TerminalID]
		delete(s.terminals, input.TerminalID)
		s.mu.Unlock()
		if current != nil {
			_ = current.input.Close()
			current.cancel()
		}
	}()
	return nil
}

func (s *Supervisor) copyTerminalOutput(
	ctx context.Context,
	terminalID string,
	reader io.Reader,
) {
	buffer := make([]byte, 16<<10)
	for {
		count, err := reader.Read(buffer)
		if count > 0 {
			data := append([]byte(nil), buffer[:count]...)
			if outputErr := s.Control.PublishTerminalOutput(ctx, terminalID, data); outputErr != nil &&
				ctx.Err() == nil {
				s.Logger.Warn("publish terminal output", "error", outputErr, "terminal_id", terminalID)
			}
		}
		if err != nil {
			return
		}
	}
}

func (s *Supervisor) writeTerminal(input worker.TerminalCommand) error {
	if input.TerminalID == "" || len(input.Data) == 0 || len(input.Data) > 16<<10 {
		return errors.New("invalid terminal input request")
	}
	s.mu.Lock()
	terminal := s.terminals[input.TerminalID]
	s.mu.Unlock()
	if terminal == nil {
		return errors.New("terminal is not open")
	}
	_, err := terminal.input.Write(input.Data)
	return err
}

func (s *Supervisor) closeTerminal(id string) {
	s.mu.Lock()
	terminal := s.terminals[id]
	delete(s.terminals, id)
	s.mu.Unlock()
	if terminal != nil {
		_ = terminal.input.Close()
		terminal.cancel()
	}
}

func (s *Supervisor) closeAllTerminals() {
	s.mu.Lock()
	terminals := s.terminals
	s.terminals = make(map[string]*terminalProcess)
	s.mu.Unlock()
	for _, terminal := range terminals {
		_ = terminal.input.Close()
		terminal.cancel()
	}
}

func decodePayload(payload any, target any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, target)
}

func transportError(err error) (string, string) {
	switch {
	case errors.Is(err, errUnsafePath):
		return "INVALID_WORKSPACE_PATH", "The requested path is outside the workspace."
	case errors.Is(err, os.ErrNotExist):
		return "WORKSPACE_NOT_FOUND", "The requested workspace path does not exist."
	case errors.Is(err, os.ErrPermission):
		return "WORKSPACE_PERMISSION_DENIED", "The worker denied access to the workspace path."
	default:
		return "WORKER_OPERATION_FAILED", "The worker could not complete the operation."
	}
}
